// Git smart HTTP: the /{owner}/{repo}.git surface.
//
//   GET  info/refs?service=git-upload-pack    protocol v2 capability advertisement when the client
//                                             sends Git-Protocol: version=2, else the v0 ref ad
//   GET  info/refs?service=git-receive-pack   the v0 ref advertisement (receive-pack is v0-only)
//   POST git-upload-pack                      v2 ls-refs and fetch (with shallow/deepen planning),
//                                             or the v0 want/have exchange
//   POST git-receive-pack                     v0 push: command list + packfile, report-status in
//                                             side-band-64k, per-ref fast-forward enforcement
//
// The fetch planner computes exactly the objects a client lacks: the closure of the wants minus
// the closure of the haves (a shallow boundary commit counts as held, its parents do not), or,
// with a depth, the commits within that many generations of the wants plus their trees and blobs,
// reporting the new shallow boundary and any commits the deepen un-shallows.

import {
  PKT_FLUSH,
  ZERO_OID,
  collectReachable,
  isAncestor,
  isOid,
  parseAllPackets,
  parseCommit,
  parsePackets,
  parseTag,
  peelToCommit,
  pktLine,
  readPack,
  writePack,
  type GitObj,
  type Packet,
} from './gitobj.ts';
import { Forge, type RepoRec, headTarget } from './store.ts';

export interface GitReply {
  status: number;
  contentType: string;
  body: Buffer;
}

const AGENT = 'github-core-clone/1.0';

function jsonError(status: number, message: string): GitReply {
  return { status, contentType: 'application/json; charset=utf-8', body: Buffer.from(`${JSON.stringify({ message })}\n`) };
}

export function gitRepo(forge: Forge, owner: string, name: string): RepoRec | undefined {
  return forge.getRepo(owner, name);
}

// ----------------------------------------------------------------------------------------------
// advertisements

function sortedRefs(repo: RepoRec): Array<[string, string]> {
  return [...repo.refs.entries()].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
}

function v0Advertisement(repo: RepoRec, service: 'git-upload-pack' | 'git-receive-pack'): Buffer {
  const caps =
    service === 'git-upload-pack'
      ? `multi_ack_detailed side-band-64k thin-pack ofs-delta shallow symref=HEAD:${headTarget(repo)} agent=${AGENT}`
      : `report-status delete-refs side-band-64k ofs-delta symref=HEAD:${headTarget(repo)} agent=${AGENT}`;
  const parts: Buffer[] = [pktLine(`# service=${service}\n`), PKT_FLUSH];
  const refs = sortedRefs(repo);
  if (refs.length === 0) {
    parts.push(pktLine(`${ZERO_OID} capabilities^{}\0${caps}\n`), PKT_FLUSH);
    return Buffer.concat(parts);
  }
  const headOid = repo.refs.get(headTarget(repo)) ?? ZERO_OID;
  parts.push(pktLine(`${headOid} HEAD\0${caps}\n`));
  for (const [name, oid] of refs) {
    parts.push(pktLine(`${oid} ${name}\n`));
    const obj = repo.store.get(oid);
    if (obj?.type === 'tag') parts.push(pktLine(`${peelToCommit(repo.store, oid)} ${name}^{}\n`));
  }
  parts.push(PKT_FLUSH);
  return Buffer.concat(parts);
}

function v2Advertisement(): Buffer {
  return Buffer.concat([
    pktLine('version 2\n'),
    pktLine(`agent=${AGENT}\n`),
    pktLine('ls-refs=unborn\n'),
    pktLine('fetch=shallow\n'),
    pktLine('object-format=sha1\n'),
    PKT_FLUSH,
  ]);
}

export function handleInfoRefs(
  forge: Forge,
  owner: string,
  name: string,
  service: string | null,
  gitProtocol: string | undefined,
): GitReply {
  if (service !== 'git-upload-pack' && service !== 'git-receive-pack') {
    return jsonError(400, 'Unsupported service');
  }
  const repo = gitRepo(forge, owner, name);
  if (!repo) return jsonError(404, 'Not Found');
  const contentType = `application/x-${service}-advertisement`;
  if (service === 'git-upload-pack' && (gitProtocol ?? '').includes('version=2')) {
    return { status: 200, contentType, body: v2Advertisement() };
  }
  return { status: 200, contentType, body: v0Advertisement(repo, service) };
}

// ----------------------------------------------------------------------------------------------
// ls-refs (protocol v2)

function lsRefs(repo: RepoRec, packets: Packet[]): Buffer {
  let peel = false;
  let symrefs = false;
  let unborn = false;
  const prefixes: string[] = [];
  for (const packet of packets) {
    if (packet.kind !== 'data') continue;
    const line = packet.payload.toString('utf8').replace(/\n$/, '');
    if (line === 'peel') peel = true;
    else if (line === 'symrefs') symrefs = true;
    else if (line === 'unborn') unborn = true;
    else if (line.startsWith('ref-prefix ')) prefixes.push(line.slice('ref-prefix '.length));
  }
  const matches = (name: string): boolean => prefixes.length === 0 || prefixes.some((prefix) => name.startsWith(prefix));
  const lines: string[] = [];
  const target = headTarget(repo);
  const headOid = repo.refs.get(target);
  if (prefixes.length === 0 || prefixes.some((prefix) => 'HEAD'.startsWith(prefix))) {
    if (headOid) lines.push(`${headOid} HEAD${symrefs ? ` symref-target:${target}` : ''}\n`);
    else if (unborn) lines.push(`unborn HEAD${symrefs ? ` symref-target:${target}` : ''}\n`);
  }
  for (const [name, oid] of sortedRefs(repo)) {
    if (!matches(name)) continue;
    let line = `${oid} ${name}`;
    if (peel) {
      const obj = repo.store.get(oid);
      if (obj?.type === 'tag') line += ` peeled:${peelToCommit(repo.store, oid)}`;
    }
    lines.push(`${line}\n`);
  }
  return Buffer.concat([...lines.map((line) => pktLine(line)), PKT_FLUSH]);
}

// ----------------------------------------------------------------------------------------------
// fetch planning

interface FetchPlan {
  objects: GitObj[];
  shallow: string[];
  unshallow: string[];
}

const TYPE_RANK: Record<GitObj['type'], number> = { commit: 0, tree: 1, blob: 2, tag: 3 };

function planFetch(
  repo: RepoRec,
  wants: readonly string[],
  haves: readonly string[],
  clientShallow: ReadonlySet<string>,
  depth: number | undefined,
): FetchPlan {
  const store = repo.store;
  const haveClosure = collectReachable(store, haves, clientShallow);
  const pack = (oids: Iterable<string>): GitObj[] => {
    const list: GitObj[] = [];
    for (const oid of oids) {
      const obj = store.get(oid);
      if (obj) list.push(obj);
    }
    return list.sort((a, b) => TYPE_RANK[a.type] - TYPE_RANK[b.type]);
  };

  if (depth === undefined) {
    const wanted = collectReachable(store, wants);
    const send = [...wanted].filter((oid) => !haveClosure.has(oid));
    return { objects: pack(send), shallow: [], unshallow: [] };
  }

  // Depth-limited: generations count from the wants; a tag want contributes its commit at
  // generation 1 and is itself always sent (when not already held).
  const generation = new Map<string, number>();
  const extra = new Set<string>();
  const queue: Array<[string, number]> = [];
  for (const want of wants) {
    const obj = store.get(want);
    if (!obj) continue;
    if (obj.type === 'tag') {
      extra.add(want);
      queue.push([parseTag(obj.data).object, 1]);
    } else if (obj.type === 'commit') {
      queue.push([want, 1]);
    } else {
      extra.add(want);
    }
  }
  while (queue.length) {
    const [oid, gen] = queue.shift()!;
    if (gen > depth) continue;
    const known = generation.get(oid);
    if (known !== undefined && known <= gen) continue;
    generation.set(oid, gen);
    const obj = store.get(oid);
    if (!obj || obj.type !== 'commit') continue;
    for (const parent of parseCommit(obj.data).parents) queue.push([parent, gen + 1]);
  }
  const included = new Set<string>(extra);
  for (const oid of generation.keys()) {
    included.add(oid);
    const tree = parseCommit(store.get(oid)!.data).tree;
    for (const sub of collectReachable(store, [tree])) included.add(sub);
  }
  const boundary = new Set<string>();
  for (const [oid, gen] of generation) {
    if (gen !== depth) continue;
    const obj = store.get(oid);
    if (obj && obj.type === 'commit' && parseCommit(obj.data).parents.length > 0) boundary.add(oid);
  }
  const shallow = [...boundary].filter((oid) => !clientShallow.has(oid));
  const unshallow = [...clientShallow].filter((oid) => generation.has(oid) && !boundary.has(oid));
  const send = [...included].filter((oid) => !haveClosure.has(oid));
  return { objects: pack(send), shallow, unshallow };
}

/** Frame a pack as band-1 sideband pkt-lines (32768 data bytes a packet). */
function sidebandPackets(pack: Buffer): Buffer[] {
  const parts: Buffer[] = [];
  const CHUNK = 32768;
  for (let offset = 0; offset < pack.length; offset += CHUNK) {
    const chunk = pack.subarray(offset, Math.min(pack.length, offset + CHUNK));
    parts.push(pktLine(Buffer.concat([Buffer.from([1]), chunk])));
  }
  if (parts.length === 0) parts.push(pktLine(Buffer.concat([Buffer.from([1]), Buffer.alloc(0)])));
  return parts;
}

interface FetchArgs {
  wants: string[];
  haves: string[];
  shallow: string[];
  depth?: number;
  done: boolean;
}

function fetchResponse(repo: RepoRec, args: FetchArgs, version2: boolean): Buffer {
  const plan = planFetch(repo, args.wants, args.haves, new Set(args.shallow), args.depth);
  const pack = writePack(plan.objects);
  if (!version2) {
    return Buffer.concat([pktLine('NAK\n'), ...sidebandPackets(pack), PKT_FLUSH]);
  }
  if (!args.done) {
    // A negotiation round: acknowledgments only, no pack yet.
    return Buffer.concat([pktLine('acknowledgments\n'), pktLine('NAK\n'), PKT_FLUSH]);
  }
  // Once the client said done, git's v2 state machine expects the packfile sections directly:
  // an acknowledgments section here is a protocol error to it.
  const parts: Buffer[] = [];
  if (plan.shallow.length || plan.unshallow.length) {
    parts.push(pktLine('shallow-info\n'));
    for (const oid of plan.shallow) parts.push(pktLine(`shallow ${oid}\n`));
    for (const oid of plan.unshallow) parts.push(pktLine(`unshallow ${oid}\n`));
    parts.push(PKT_FLUSH);
  }
  parts.push(pktLine('packfile\n'), ...sidebandPackets(pack), PKT_FLUSH);
  return Buffer.concat(parts);
}

// ----------------------------------------------------------------------------------------------
// upload-pack POST

export function handleUploadPack(repo: RepoRec, body: Buffer, gitProtocol: string | undefined): GitReply {
  const version2 = (gitProtocol ?? '').includes('version=2');
  const packets = parseAllPackets(body);
  const lines: string[] = [];
  for (const packet of packets) {
    if (packet.kind === 'data') lines.push(packet.payload.toString('utf8'));
  }
  const contentType = 'application/x-git-upload-pack-result';

  if (version2) {
    const commandLine = lines.find((line) => line.startsWith('command='));
    const command = commandLine?.slice('command='.length).replace(/\n$/, '');
    if (command === 'ls-refs') return { status: 200, contentType, body: lsRefs(repo, packets) };
    if (command === 'fetch') {
      const args: FetchArgs = { wants: [], haves: [], shallow: [], done: false };
      for (const raw of lines) {
        const line = raw.replace(/\n$/, '');
        if (line.startsWith('want ')) args.wants.push(line.slice(5).trim());
        else if (line.startsWith('have ')) args.haves.push(line.slice(5).trim());
        else if (line.startsWith('shallow ')) args.shallow.push(line.slice(8).trim());
        else if (line.startsWith('deepen ')) args.depth = Number.parseInt(line.slice(7), 10);
        else if (line === 'done') args.done = true;
      }
      return { status: 200, contentType, body: fetchResponse(repo, args, true) };
    }
    return jsonError(400, `Unsupported command ${command ?? ''}`);
  }

  // Protocol v0: wants in the first section, haves and done in the second.
  const args: FetchArgs = { wants: [], haves: [], shallow: [], done: true };
  for (const raw of lines) {
    const line = raw.replace(/\n$/, '');
    if (line.startsWith('want ')) args.wants.push(line.slice(5).trim().split(' ')[0]);
    else if (line.startsWith('have ')) args.haves.push(line.slice(5).trim());
    else if (line.startsWith('shallow ')) args.shallow.push(line.slice(8).trim());
    else if (line.startsWith('deepen ')) args.depth = Number.parseInt(line.slice(7), 10);
  }
  return { status: 200, contentType, body: fetchResponse(repo, args, false) };
}

// ----------------------------------------------------------------------------------------------
// receive-pack POST

interface PushCommand {
  oldOid: string;
  newOid: string;
  ref: string;
}

export function handleReceivePack(repo: RepoRec, body: Buffer): GitReply {
  const { packets, rest } = parsePackets(body);
  const commands: PushCommand[] = [];
  const capabilities = new Set<string>();
  let first = true;
  for (const packet of packets) {
    if (packet.kind !== 'data') continue;
    let text = packet.payload.toString('utf8').replace(/\n$/, '');
    if (first) {
      first = false;
      const nul = text.indexOf('\0');
      if (nul >= 0) {
        for (const cap of text.slice(nul + 1).split(' ')) if (cap) capabilities.add(cap);
        text = text.slice(0, nul);
      }
    }
    const parts = text.split(' ');
    if (parts.length === 3 && isOid(parts[0]) && isOid(parts[1])) {
      commands.push({ oldOid: parts[0], newOid: parts[1], ref: parts[2] });
    }
  }

  // Unpack first: every object lands in the store before any ref moves (git quarantines them;
  // unreachable leftovers are never advertised or fetched, so the net effect is the same).
  let unpackOk = true;
  let unpackDetail = 'ok';
  if (rest.length > 0) {
    try {
      const objects = readPack(rest, (oid) => repo.store.get(oid));
      for (const [oid, obj] of objects) repo.store.putVerified(oid, obj);
    } catch (err) {
      unpackOk = false;
      unpackDetail = err instanceof Error ? err.message : 'unpack failed';
    }
  }

  const results: Array<{ ref: string; ok: boolean; reason: string }> = [];
  for (const command of commands) {
    const fail = (reason: string): void => {
      results.push({ ref: command.ref, ok: false, reason });
    };
    if (!unpackOk) {
      fail('unpack failed');
      continue;
    }
    const current = repo.refs.get(command.ref) ?? ZERO_OID;
    if (command.oldOid !== current) {
      fail('stale info');
      continue;
    }
    if (command.newOid === ZERO_OID) {
      repo.refs.delete(command.ref);
      results.push({ ref: command.ref, ok: true, reason: '' });
      continue;
    }
    const target = repo.store.get(command.newOid);
    if (!target) {
      fail('not found');
      continue;
    }
    if (command.ref.startsWith('refs/heads/') && target.type !== 'commit') {
      fail('invalid object');
      continue;
    }
    if (
      command.oldOid !== ZERO_OID &&
      target.type === 'commit' &&
      !isAncestor(repo.store, command.oldOid, command.newOid)
    ) {
      fail('non-fast-forward');
      continue;
    }
    repo.refs.set(command.ref, command.newOid);
    results.push({ ref: command.ref, ok: true, reason: '' });
  }

  const contentType = 'application/x-git-receive-pack-result';
  if (!capabilities.has('report-status') && !capabilities.has('report-status-v2')) {
    return { status: 200, contentType, body: Buffer.alloc(0) };
  }
  const reportParts: Buffer[] = [pktLine(unpackOk ? 'unpack ok\n' : `unpack ${unpackDetail}\n`)];
  for (const result of results) {
    reportParts.push(pktLine(result.ok ? `ok ${result.ref}\n` : `ng ${result.ref} ${result.reason}\n`));
  }
  reportParts.push(PKT_FLUSH);
  const report = Buffer.concat(reportParts);
  if (!capabilities.has('side-band-64k')) {
    return { status: 200, contentType, body: report };
  }
  // With side-band-64k the report stream itself rides inside band-1 packets.
  const framed: Buffer[] = [];
  const CHUNK = 32768;
  for (let offset = 0; offset < report.length; offset += CHUNK) {
    const chunk = report.subarray(offset, Math.min(report.length, offset + CHUNK));
    framed.push(pktLine(Buffer.concat([Buffer.from([1]), chunk])));
  }
  framed.push(PKT_FLUSH);
  return { status: 200, contentType, body: Buffer.concat(framed) };
}

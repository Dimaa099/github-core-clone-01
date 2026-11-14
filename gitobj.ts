// The git object model and packfile codec, implemented from the git wire format with Node's
// standard library only (node:crypto for SHA-1, node:zlib for the deflate streams).
//
// Objects are stored loose in memory: a Map from the 40-hex SHA-1 id to {type, data}, where the id
// is SHA-1 over "<type> <size>\0" + data, exactly as git computes it. The pack reader resolves
// OFS_DELTA and REF_DELTA entries (including thin-pack bases supplied by the caller's store); the
// pack writer emits plain, undeltified objects, which every git reader accepts.

import { createHash } from 'node:crypto';
import { deflateSync, inflateSync } from 'node:zlib';

export type ObjType = 'commit' | 'tree' | 'blob' | 'tag';

export interface GitObj {
  type: ObjType;
  data: Buffer;
}

export const ZERO_OID = '0'.repeat(40);
const HEX40 = /^[0-9a-f]{40}$/;

export function isOid(value: string): boolean {
  return HEX40.test(value);
}

/** SHA-1 over the loose-object framing `<type> <size>\0` + bytes. */
export function hashObject(type: ObjType, data: Buffer): string {
  const hash = createHash('sha1');
  hash.update(Buffer.from(`${type} ${data.length}\0`, 'utf8'));
  hash.update(data);
  return hash.digest('hex');
}

/** An in-memory loose-object store for one repository. */
export class ObjectStore {
  readonly objects = new Map<string, GitObj>();

  has(oid: string): boolean {
    return this.objects.has(oid);
  }

  get(oid: string): GitObj | undefined {
    return this.objects.get(oid);
  }

  /** Store `data` as `type`; returns its id. Idempotent: the same bytes give the same id. */
  put(type: ObjType, data: Buffer): string {
    const oid = hashObject(type, data);
    if (!this.objects.has(oid)) this.objects.set(oid, { type, data });
    return oid;
  }

  /** Store an object whose id is already known (pack ingest); the hash is verified. */
  putVerified(oid: string, obj: GitObj): void {
    if (hashObject(obj.type, obj.data) !== oid) throw new Error(`object ${oid} does not hash to its id`);
    if (!this.objects.has(oid)) this.objects.set(oid, obj);
  }

  /**
   * Store an object whose id the caller derived by hashing this exact data itself (the pack
   * reader computes every id it returns), so re-hashing would only repeat the same work.
   */
  putTrusted(oid: string, obj: GitObj): void {
    if (!this.objects.has(oid)) this.objects.set(oid, obj);
  }
}

// ----------------------------------------------------------------------------------------------
// parse caches: object bytes are content-addressed and immutable, so a parse keyed by id is
// valid for the life of the process. The walkers below (ancestry, reachability, listings) are
// the hot paths — a push's fast-forward check walks the whole chain on every push.

const commitParseCache = new Map<string, CommitView>();
const treeParseCache = new Map<string, TreeEntry[]>();
const PARSE_CACHE_LIMIT = 100_000;

export function parseCommitByOid(store: ObjectStore, oid: string): CommitView | undefined {
  const cached = commitParseCache.get(oid);
  if (cached) return cached;
  const obj = store.get(oid);
  if (!obj || obj.type !== 'commit') return undefined;
  const parsed = parseCommit(obj.data);
  if (commitParseCache.size < PARSE_CACHE_LIMIT) commitParseCache.set(oid, parsed);
  return parsed;
}

export function parseTreeByOid(store: ObjectStore, oid: string): TreeEntry[] | undefined {
  const cached = treeParseCache.get(oid);
  if (cached) return cached;
  const obj = store.get(oid);
  if (!obj || obj.type !== 'tree') return undefined;
  const parsed = parseTree(obj.data);
  if (treeParseCache.size < PARSE_CACHE_LIMIT) treeParseCache.set(oid, parsed);
  return parsed;
}

// ----------------------------------------------------------------------------------------------
// commit / tree / tag parsing and building

export interface CommitView {
  tree: string;
  parents: string[];
  author: string;
  committer: string;
  message: string;
}

export function parseCommit(data: Buffer): CommitView {
  const text = data.toString('utf8');
  const blank = text.indexOf('\n\n');
  const header = blank < 0 ? text : text.slice(0, blank);
  const message = blank < 0 ? '' : text.slice(blank + 2);
  let tree = '';
  const parents: string[] = [];
  let author = '';
  let committer = '';
  for (const line of header.split('\n')) {
    if (line.startsWith('tree ')) tree = line.slice(5).trim();
    else if (line.startsWith('parent ')) parents.push(line.slice(7).trim());
    else if (line.startsWith('author ')) author = line.slice(7);
    else if (line.startsWith('committer ')) committer = line.slice(10);
  }
  return { tree, parents, author, committer, message };
}

export function buildCommit(fields: {
  tree: string;
  parents: readonly string[];
  author: string;
  committer: string;
  message: string;
}): Buffer {
  const lines = [`tree ${fields.tree}`];
  for (const parent of fields.parents) lines.push(`parent ${parent}`);
  lines.push(`author ${fields.author}`, `committer ${fields.committer}`, '');
  return Buffer.from(`${lines.join('\n')}\n${fields.message}`, 'utf8');
}

export interface TagView {
  object: string;
  type: ObjType;
  tag: string;
  tagger: string;
  message: string;
}

export function parseTag(data: Buffer): TagView {
  const text = data.toString('utf8');
  const blank = text.indexOf('\n\n');
  const header = blank < 0 ? text : text.slice(0, blank);
  const out: TagView = { object: '', type: 'commit', tag: '', tagger: '', message: blank < 0 ? '' : text.slice(blank + 2) };
  for (const line of header.split('\n')) {
    const space = line.indexOf(' ');
    if (space < 0) continue;
    const key = line.slice(0, space);
    const value = line.slice(space + 1);
    if (key === 'object') out.object = value.trim();
    else if (key === 'type') out.type = value.trim() as ObjType;
    else if (key === 'tag') out.tag = value;
    else if (key === 'tagger') out.tagger = value;
  }
  return out;
}

export interface TreeEntry {
  mode: string;
  name: string;
  oid: string;
}

export function parseTree(data: Buffer): TreeEntry[] {
  const entries: TreeEntry[] = [];
  let offset = 0;
  while (offset < data.length) {
    const space = data.indexOf(0x20, offset);
    const nul = data.indexOf(0x00, space + 1);
    const mode = data.subarray(offset, space).toString('ascii');
    const name = data.subarray(space + 1, nul).toString('utf8');
    const oid = data.subarray(nul + 1, nul + 21).toString('hex');
    entries.push({ mode, name, oid });
    offset = nul + 21;
  }
  return entries;
}

/** git's tree sort: by name bytes, a directory comparing as if its name ended in '/'. */
function compareTreeEntries(a: TreeEntry, b: TreeEntry): number {
  const left = Buffer.from(a.mode === '40000' ? `${a.name}/` : a.name, 'utf8');
  const right = Buffer.from(b.mode === '40000' ? `${b.name}/` : b.name, 'utf8');
  return Buffer.compare(left, right);
}

export function buildTree(entries: readonly TreeEntry[]): Buffer {
  const sorted = [...entries].sort(compareTreeEntries);
  const parts: Buffer[] = [];
  for (const entry of sorted) {
    parts.push(Buffer.from(`${entry.mode} ${entry.name}\0`, 'utf8'));
    parts.push(Buffer.from(entry.oid, 'hex'));
  }
  return Buffer.concat(parts);
}

/** Build (and store) nested trees for a flat path -> blob-oid map; returns the root tree id. */
export function treeFromFiles(store: ObjectStore, files: ReadonlyMap<string, string>): string {
  interface Node {
    dirs: Map<string, Node>;
    files: Map<string, string>;
  }
  const root: Node = { dirs: new Map(), files: new Map() };
  for (const [path, oid] of files) {
    const segments = path.split('/');
    let node = root;
    for (const segment of segments.slice(0, -1)) {
      let next = node.dirs.get(segment);
      if (!next) {
        next = { dirs: new Map(), files: new Map() };
        node.dirs.set(segment, next);
      }
      node = next;
    }
    node.files.set(segments[segments.length - 1], oid);
  }
  const build = (node: Node): string => {
    const entries: TreeEntry[] = [];
    for (const [name, oid] of node.files) entries.push({ mode: '100644', name, oid });
    for (const [name, child] of node.dirs) entries.push({ mode: '40000', name, oid: build(child) });
    return store.put('tree', buildTree(entries));
  };
  return build(root);
}

/** Flatten a tree into path -> {oid, mode}; a missing tree flattens to nothing. */
export function flattenTree(store: ObjectStore, treeOid: string | undefined): Map<string, { oid: string; mode: string }> {
  const out = new Map<string, { oid: string; mode: string }>();
  if (!treeOid) return out;
  const walk = (oid: string, prefix: string): void => {
    const obj = store.get(oid);
    if (!obj || obj.type !== 'tree') return;
    for (const entry of parseTreeByOid(store, oid) ?? []) {
      const path = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
      if (entry.mode === '40000') walk(entry.oid, path);
      else out.set(path, { oid: entry.oid, mode: entry.mode });
    }
  };
  walk(treeOid, '');
  return out;
}

/** The tree id a commit names, or undefined when the commit is unknown. */
export function commitTree(store: ObjectStore, commitOid: string): string | undefined {
  return parseCommitByOid(store, commitOid)?.tree;
}

/** Peel tags to the object they ultimately name (a commit, in every case the suite builds). */
export function peelToCommit(store: ObjectStore, oid: string): string {
  let current = oid;
  for (let hops = 0; hops < 16; hops += 1) {
    const obj = store.get(current);
    if (!obj) return current;
    if (obj.type !== 'tag') return current;
    current = parseTag(obj.data).object;
  }
  return current;
}

// ----------------------------------------------------------------------------------------------
// reachability

/**
 * Every object reachable from `roots`. Commit traversal stops below a commit in `shallowBoundary`
 * (the commit itself is included; its parents are not), which models what a shallow client holds.
 */
export function collectReachable(store: ObjectStore, roots: Iterable<string>, shallowBoundary?: ReadonlySet<string>): Set<string> {
  const seen = new Set<string>();
  const queue: string[] = [];
  for (const root of roots) if (isOid(root)) queue.push(root);
  while (queue.length) {
    const oid = queue.pop()!;
    if (seen.has(oid)) continue;
    const obj = store.get(oid);
    if (!obj) continue;
    seen.add(oid);
    if (obj.type === 'commit') {
      const commit = parseCommitByOid(store, oid)!;
      queue.push(commit.tree);
      if (!(shallowBoundary && shallowBoundary.has(oid))) {
        for (const parent of commit.parents) queue.push(parent);
      }
    } else if (obj.type === 'tag') {
      queue.push(parseTag(obj.data).object);
    } else if (obj.type === 'tree') {
      for (const entry of parseTreeByOid(store, oid) ?? []) {
        if (entry.mode === '160000') continue;
        queue.push(entry.oid);
      }
    }
  }
  return seen;
}

/** True when `ancestor` is `descendant` itself or one of its ancestors. */
export function isAncestor(store: ObjectStore, ancestor: string, descendant: string): boolean {
  const seen = new Set<string>();
  const queue = [descendant];
  while (queue.length) {
    const oid = queue.pop()!;
    if (oid === ancestor) return true;
    if (seen.has(oid)) continue;
    seen.add(oid);
    const obj = store.get(oid);
    if (!obj || obj.type !== 'commit') continue;
    for (const parent of parseCommitByOid(store, oid)?.parents ?? []) queue.push(parent);
  }
  return false;
}

/** The nearest common ancestor of two commits (a merge base), or null for unrelated histories. */
export function mergeBase(store: ObjectStore, a: string, b: string): string | null {
  const ancestorsOf = (tip: string): Map<string, number> => {
    const dist = new Map<string, number>();
    const queue: Array<[string, number]> = [[tip, 0]];
    while (queue.length) {
      const [oid, depth] = queue.shift()!;
      if (dist.has(oid)) continue;
      dist.set(oid, depth);
      const obj = store.get(oid);
      if (!obj || obj.type !== 'commit') continue;
      for (const parent of parseCommitByOid(store, oid)?.parents ?? []) queue.push([parent, depth + 1]);
    }
    return dist;
  };
  const fromA = ancestorsOf(a);
  const fromB = ancestorsOf(b);
  let best: string | null = null;
  let bestScore = Number.POSITIVE_INFINITY;
  for (const [oid, depthA] of fromA) {
    const depthB = fromB.get(oid);
    if (depthB === undefined) continue;
    const score = depthA + depthB;
    if (score < bestScore) {
      bestScore = score;
      best = oid;
    }
  }
  return best;
}

/** Ancestor commits of `tip`, newest first (a depth-first walk; histories here are near-linear). */
export function listCommits(store: ObjectStore, tip: string, limit: number): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const stack = [tip];
  while (stack.length && out.length < limit) {
    const oid = stack.pop()!;
    if (seen.has(oid)) continue;
    const obj = store.get(oid);
    if (!obj || obj.type !== 'commit') continue;
    seen.add(oid);
    out.push(oid);
    const parents = parseCommitByOid(store, oid)?.parents ?? [];
    for (let i = parents.length - 1; i >= 0; i -= 1) stack.push(parents[i]);
  }
  return out;
}

// ----------------------------------------------------------------------------------------------
// packfile write (plain objects, no deltas)

const TYPE_CODE: Record<ObjType, number> = { commit: 1, tree: 2, blob: 3, tag: 4 };
const CODE_TYPE: Record<number, ObjType> = { 1: 'commit', 2: 'tree', 3: 'blob', 4: 'tag' };

function packObjectHeader(type: ObjType, size: number): Buffer {
  const code = TYPE_CODE[type];
  const bytes: number[] = [];
  let remaining = size;
  let first = (code << 4) | (remaining & 0x0f);
  remaining = Math.floor(remaining / 16);
  while (remaining > 0) {
    bytes.push(first | 0x80);
    first = remaining & 0x7f;
    remaining = Math.floor(remaining / 128);
  }
  bytes.push(first);
  return Buffer.from(bytes);
}

/** Build a version-2 packfile from whole objects, in the order given. */
export function writePack(objects: ReadonlyArray<GitObj>): Buffer {
  const parts: Buffer[] = [];
  const header = Buffer.allocUnsafe(12);
  header.write('PACK', 0, 4, 'ascii');
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(objects.length, 8);
  parts.push(header);
  for (const obj of objects) {
    parts.push(packObjectHeader(obj.type, obj.data.length));
    parts.push(deflateSync(obj.data));
  }
  const body = Buffer.concat(parts);
  return Buffer.concat([body, createHash('sha1').update(body).digest()]);
}

// ----------------------------------------------------------------------------------------------
// packfile read (with OFS_DELTA / REF_DELTA resolution)

function readPackVarint(buffer: Buffer, start: number): { size: number; next: number; first: number } {
  let byte = buffer[start];
  const first = byte;
  let size = byte & 0x0f;
  let shift = 4;
  let offset = start + 1;
  while (byte & 0x80) {
    byte = buffer[offset++];
    size += (byte & 0x7f) * 2 ** shift;
    shift += 7;
    if (shift > 63) throw new Error('pack entry size varint is too long');
  }
  return { size, next: offset, first };
}

function readOfsBase(buffer: Buffer, start: number): { baseOffset: number; next: number } {
  let byte = buffer[start];
  let offset = start + 1;
  let value = byte & 0x7f;
  while (byte & 0x80) {
    byte = buffer[offset++];
    value = (value + 1) * 128 + (byte & 0x7f);
  }
  return { baseOffset: value, next: offset };
}

function inflateAt(buffer: Buffer, offset: number): { data: Buffer; next: number } {
  const result = inflateSync(buffer.subarray(offset), { info: true }) as unknown as {
    buffer: Buffer;
    engine: { bytesWritten: number };
  };
  return { data: result.buffer, next: offset + result.engine.bytesWritten };
}

/** Apply a git delta instruction stream to a base object's bytes. */
export function applyDelta(base: Buffer, delta: Buffer): Buffer {
  let offset = 0;
  const readSize = (): number => {
    let value = 0;
    let shift = 0;
    for (;;) {
      const byte = delta[offset++];
      value += (byte & 0x7f) * 2 ** shift;
      shift += 7;
      if (!(byte & 0x80)) break;
    }
    return value;
  };
  const sourceSize = readSize();
  const targetSize = readSize();
  if (sourceSize !== base.length) throw new Error(`delta base size mismatch: ${sourceSize} vs ${base.length}`);
  const out = Buffer.allocUnsafe(targetSize);
  let written = 0;
  while (offset < delta.length) {
    const op = delta[offset++];
    if (op & 0x80) {
      let copyOffset = 0;
      let copySize = 0;
      let shift = 0;
      for (let bit = 0; bit < 4; bit += 1) {
        if (op & (1 << bit)) copyOffset += delta[offset++] * 2 ** shift;
        shift += 8;
      }
      shift = 0;
      for (let bit = 4; bit < 7; bit += 1) {
        if (op & (1 << bit)) copySize += delta[offset++] * 2 ** shift;
        shift += 8;
      }
      if (copySize === 0) copySize = 0x10000;
      base.copy(out, written, copyOffset, copyOffset + copySize);
      written += copySize;
    } else if (op !== 0) {
      const literal = op & 0x7f;
      delta.copy(out, written, offset, offset + literal);
      offset += literal;
      written += literal;
    } else {
      throw new Error('delta opcode 0 is invalid');
    }
  }
  if (written !== targetSize) throw new Error(`delta produced ${written} of ${targetSize} bytes`);
  return out;
}

interface RawPackEntry {
  offset: number;
  typeCode: number;
  data: Buffer;
  baseOffset?: number;
  baseOid?: string;
  resolved?: GitObj;
  oid?: string;
}

/**
 * Read a packfile and resolve every entry to a whole object. `resolveBase` answers objects a thin
 * pack leaves out (the receive-pack path passes the repository's own store). The trailer checksum
 * and every object's size are verified; anything malformed throws.
 */
export function readPack(pack: Buffer, resolveBase?: (oid: string) => GitObj | undefined): Map<string, GitObj> {
  if (pack.length < 32 || pack.subarray(0, 4).toString('ascii') !== 'PACK') throw new Error('not a packfile');
  const version = pack.readUInt32BE(4);
  if (version !== 2 && version !== 3) throw new Error(`unsupported pack version ${version}`);
  const count = pack.readUInt32BE(8);
  const trailerStart = pack.length - 20;
  const trailer = pack.subarray(trailerStart).toString('hex');
  const computed = createHash('sha1').update(pack.subarray(0, trailerStart)).digest('hex');
  if (trailer !== computed) throw new Error('pack trailer checksum mismatch');

  const raw: RawPackEntry[] = [];
  const byOffset = new Map<number, RawPackEntry>();
  let offset = 12;
  for (let index = 0; index < count; index += 1) {
    const entryOffset = offset;
    const header = readPackVarint(pack, offset);
    offset = header.next;
    const typeCode = (header.first >> 4) & 0x07;
    const entry: RawPackEntry = { offset: entryOffset, typeCode, data: Buffer.alloc(0) };
    if (typeCode === 6) {
      const base = readOfsBase(pack, offset);
      offset = base.next;
      entry.baseOffset = entryOffset - base.baseOffset;
    } else if (typeCode === 7) {
      entry.baseOid = pack.subarray(offset, offset + 20).toString('hex');
      offset += 20;
    } else if (!CODE_TYPE[typeCode]) {
      throw new Error(`pack entry ${index} has unknown type code ${typeCode}`);
    }
    const inflated = inflateAt(pack.subarray(0, trailerStart), offset);
    if (inflated.data.length !== header.size) throw new Error(`pack entry at ${entryOffset} size mismatch`);
    entry.data = inflated.data;
    offset = inflated.next;
    raw.push(entry);
    byOffset.set(entryOffset, entry);
  }
  if (offset !== trailerStart) throw new Error('pack has stray bytes before its trailer');

  const resolvedByOid = new Map<string, RawPackEntry>();
  const resolving = new Set<number>();
  const resolve = (entry: RawPackEntry): GitObj => {
    if (entry.resolved) return entry.resolved;
    if (resolving.has(entry.offset)) throw new Error('delta cycle in pack');
    resolving.add(entry.offset);
    let obj: GitObj;
    if (entry.typeCode === 6) {
      const baseEntry = byOffset.get(entry.baseOffset!);
      if (!baseEntry) throw new Error('ofs-delta base is not in the pack');
      const base = resolve(baseEntry);
      obj = { type: base.type, data: applyDelta(base.data, entry.data) };
    } else if (entry.typeCode === 7) {
      const wanted = entry.baseOid!;
      const baseEntry = resolvedByOid.get(wanted);
      if (baseEntry) {
        const base = resolve(baseEntry);
        obj = { type: base.type, data: applyDelta(base.data, entry.data) };
      } else {
        const external = resolveBase?.(wanted);
        if (!external) throw new Error(`ref-delta base ${wanted} is not available`);
        obj = { type: external.type, data: applyDelta(external.data, entry.data) };
      }
    } else {
      obj = { type: CODE_TYPE[entry.typeCode], data: entry.data };
    }
    entry.resolved = obj;
    entry.oid = hashObject(obj.type, obj.data);
    resolvedByOid.set(entry.oid, entry);
    resolving.delete(entry.offset);
    return obj;
  };

  const objects = new Map<string, GitObj>();
  for (const entry of raw) {
    const obj = resolve(entry);
    objects.set(entry.oid!, obj);
  }
  return objects;
}

// ----------------------------------------------------------------------------------------------
// pkt-line framing

export const PKT_MAX_PAYLOAD = 65516;

/** Encode one pkt-line data packet. */
export function pktLine(payload: string | Buffer): Buffer {
  const data = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : payload;
  if (data.length > PKT_MAX_PAYLOAD) throw new Error('pkt-line payload too large');
  const header = Buffer.allocUnsafe(4);
  header.write((data.length + 4).toString(16).padStart(4, '0'), 0, 4, 'ascii');
  return Buffer.concat([header, data]);
}

export const PKT_FLUSH = Buffer.from('0000', 'ascii');
export const PKT_DELIM = Buffer.from('0001', 'ascii');

export type Packet =
  | { kind: 'data'; payload: Buffer }
  | { kind: 'flush' }
  | { kind: 'delim' }
  | { kind: 'response-end' };

/**
 * Parse pkt-lines from the front of `buffer`. Stops at the first flush (inclusive) or when the
 * buffer runs out; `rest` is whatever follows (a receive-pack packfile, for instance).
 */
export function parsePackets(buffer: Buffer): { packets: Packet[]; rest: Buffer } {
  const packets: Packet[] = [];
  let offset = 0;
  while (offset + 4 <= buffer.length) {
    const header = buffer.subarray(offset, offset + 4).toString('ascii');
    if (!/^[0-9a-fA-F]{4}$/.test(header)) throw new Error(`invalid pkt-line length ${JSON.stringify(header)}`);
    const length = Number.parseInt(header, 16);
    if (length === 0) {
      packets.push({ kind: 'flush' });
      offset += 4;
      return { packets, rest: buffer.subarray(offset) };
    }
    if (length === 1) {
      packets.push({ kind: 'delim' });
      offset += 4;
      continue;
    }
    if (length === 2) {
      packets.push({ kind: 'response-end' });
      offset += 4;
      continue;
    }
    if (length < 4 || offset + length > buffer.length) throw new Error('truncated pkt-line');
    packets.push({ kind: 'data', payload: buffer.subarray(offset + 4, offset + length) });
    offset += length;
  }
  return { packets, rest: buffer.subarray(offset) };
}

/** Parse a whole request body as pkt-lines (upload-pack requests carry nothing after the flush). */
export function parseAllPackets(buffer: Buffer): Packet[] {
  const all: Packet[] = [];
  let rest = buffer;
  while (rest.length > 0) {
    const parsed = parsePackets(rest);
    if (parsed.packets.length === 0 && parsed.rest.length === rest.length) {
      throw new Error('unparseable pkt-line stream');
    }
    all.push(...parsed.packets);
    rest = parsed.rest;
  }
  return all;
}

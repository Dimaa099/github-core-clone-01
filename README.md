# github-core-clone-01

[![make.fun · github-core-clone-01](https://make.fun/badge/github-core-clone-01.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![rank](https://make.fun/badge/github-core-clone-01/Dimaa099/github-core-clone-01/rank.svg)](https://make.fun/bounty/github-core-clone-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![reward](https://make.fun/badge/github-core-clone-01/Dimaa099/github-core-clone-01/reward.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)

A GitHub-compatible git forge in a single Node 22 process, standard library only: git smart HTTP (upload-pack protocol v2, receive-pack v0, its own object model and packfile codec), the REST v3 API, a GraphQL v4 subset and an MCP endpoint, all served from one in-memory store.

## Run it

```sh
# terminal 1: a stand-in env (register/done) plus the entry
node --experimental-strip-types main.ts   # with MAKEFUN_ENV_URL and MAKEFUN_SHOP_TOKEN set

# terminal 2: the kit's conformance suite against the running entry
node --experimental-strip-types <kit>/sdk/run.ts --url http://127.0.0.1:<port> --token "$MAKEFUN_SHOP_TOKEN" --perf
```

---

<sub>Entered on [make.fun](https://make.fun/?ref=dimarz&utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01) · AI agents build software for cash rewards</sub>

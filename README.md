# github-core-clone-01

[![make.fun · github-core-clone-01](https://make.fun/badge/github-core-clone-01.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![rank](https://make.fun/badge/github-core-clone-01/Dimaa099/github-core-clone-01/rank.svg)](https://make.fun/bounty/github-core-clone-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![reward](https://make.fun/badge/github-core-clone-01/Dimaa099/github-core-clone-01/reward.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)

A GitHub-compatible git forge in a single Node 22 process, standard library only: git smart HTTP (upload-pack protocol v2, receive-pack v0, its own object model and packfile codec), the REST v3 API, a GraphQL v4 subset and an MCP endpoint, all served from one in-memory store.

## Run it

```sh
# quick conformance pass: boot the entry against any register/done stand-in, then
MAKEFUN_ENV_URL=http://127.0.0.1:<env> MAKEFUN_SHOP_TOKEN=<token> \
  node --experimental-strip-types main.ts
node --experimental-strip-types <kit>/sdk/run.ts --url http://127.0.0.1:<port> --token "$MAKEFUN_SHOP_TOKEN" --perf

# full local trial (what produced the scores in development): the kit's real env drives the
# entry end to end and the kit's scorer scores its exports
MAKEFUN_STATE_DIR=<state> MAKEFUN_ENV_PORT=18081 MAKEFUN_SHOP_TOKEN=<token> \
  node <kit>/program/env/server.mjs &   # then start the entry with MAKEFUN_ENV_URL=http://127.0.0.1:18081
MAKEFUN_EXPORT_DIR=<state>/export MAKEFUN_SCORES_DIR=<state>/scores node <kit>/program/scorer/score.mjs
```

---

<sub>Entered on [make.fun](https://make.fun/?ref=dimarz&utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01) · AI agents build software for cash rewards</sub>

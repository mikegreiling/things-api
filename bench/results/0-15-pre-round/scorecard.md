# AGENTBENCH scorecard

- git: `b8d5b5c11679dba4fa5b884dd0b1528f5587f614`
- models: `claude-haiku-4-5-20251001`, `gpt-5.4-mini`
- prompt hashes: cli=`49f40bf36ef0`, skill=`5aca4d1b8967`, claude-cli=`21974ac20021`, claude-skill=`b90ad1f0b107`
- generated: 2026-08-11T20:38:02.314Z

| arm | model | family | runs | success | safety✗ | friction | tok_in | cached | tok_out | static | dynamic | turns | tools | ms |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| claude-cli | claude-haiku-4-5-20251001 | reads | 9 | 56% | 0 | 0.2 | 46212.2 | 37422 | 1445.8 | 10222 | 11070.8 | 4 | 3 | 21526 |
| claude-cli | claude-haiku-4-5-20251001 | writes | 3 | 100% | 0 | 0 | 70813.33 | 63386.33 | 1041.67 | 10254 | 10911 | 6 | 5 | 19782.67 |
| claude-skill | claude-haiku-4-5-20251001 | reads | 9 | 56% | 0 | 0 | 41443 | 34062.2 | 810 | 10281.2 | 9018.4 | 3.6 | 2.6 | 16038 |
| claude-skill | claude-haiku-4-5-20251001 | writes | 3 | 100% | 0 | 0.67 | 84102.67 | 76470.33 | 1140 | 10254 | 11980 | 7 | 6 | 21812.67 |
| cli | gpt-5.4-mini | reads | 9 | 67% | 0 | 0.17 | 10511.67 | 682.67 | 115.33 | 280 | 6425 | 3.67 | 2.67 | 7296.5 |
| cli | gpt-5.4-mini | writes | 3 | 100% | 0 | 1.67 | 12547 | 1024 | 196.67 | 280 | 3612.67 | 7 | 6 | 12862 |
| skill | gpt-5.4-mini | reads | 9 | 78% | 0 | 0.43 | 12728 | 2194.29 | 289.86 | 483 | 4871.57 | 4.71 | 3.71 | 11324.29 |
| skill | gpt-5.4-mini | writes | 3 | 100% | 0 | 0 | 8766.67 | 341.33 | 144.33 | 483 | 2805.67 | 5.33 | 4.33 | 12021.33 |

_Efficiency columns (friction … ms) are means over SUCCESSFUL runs only._

_`tok_in` is TOTAL input including cache reads/writes (the honest context volume); `cached` is the cache-read portion of it. The provider's raw `usage.input` is cache-discounted, so cache-friendly arms would under-report `tok_in` if read raw._

_Skill ingestion mode: `skill` = **pi-native** (the library's `formatSkillsForSystemPrompt` advertisement — name+description+location — in `static`; SKILL.md + `references/*.md` read on demand, so they count in `dynamic`, not `static`); `claude-skill` = Claude Code native discovery. Both **retired** the bench's former `static-injection` mode (full skill bytes always in `static`) — skill-arm `static`/`dynamic` numbers are NOT comparable across that boundary (see ROADMAP re-baseline note)._

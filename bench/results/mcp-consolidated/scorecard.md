# AGENTBENCH scorecard

- git: `1983ea109f96d96d2aac50e4f47b10b6f1453683`
- models: `gpt-5.4-mini`
- prompt hashes: mcp=`e0bc292a876a`
- generated: 2026-07-18T15:19:37.468Z

| arm | model | family | runs | success | safety✗ | friction | tok_in | cached | tok_out | static | dynamic | turns | tools | ms |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| mcp | gpt-5.4-mini | compound | 9 | 89% | 0 | 0.13 | 32270.13 | 21056 | 138 | 12774.63 | 1517.38 | 3.25 | 3.38 | 8113.13 |
| mcp | gpt-5.4-mini | discovery | 3 | 100% | 0 | 0 | 19061.67 | 14506.67 | 46.33 | 12775 | 785.33 | 2 | 1 | 3744.33 |
| mcp | gpt-5.4-mini | domain-reasoning | 9 | 56% | 0 | 0 | 27023 | 24678.4 | 84.8 | 12781.4 | 1132.6 | 2.8 | 2.2 | 6197 |
| mcp | gpt-5.4-mini | gui-perception | 12 | 75% | 0 | 0 | 22353.44 | 20536.89 | 61.56 | 12772.67 | 861 | 2.33 | 1.56 | 6396.67 |
| mcp | gpt-5.4-mini | reads | 9 | 100% | 0 | 0.22 | 21384.22 | 19399.11 | 55.78 | 12774 | 1033.78 | 2.22 | 1.22 | 4427 |
| mcp | gpt-5.4-mini | recovery-safety | 15 | 100% | 0 | 0.13 | 26671.8 | 25019.73 | 78.73 | 12775.6 | 897.47 | 2.8 | 2.2 | 6146.2 |
| mcp | gpt-5.4-mini | writes | 24 | 79% | 0 | 0.16 | 33285.74 | 31151.16 | 96.79 | 12774.11 | 1065.95 | 3.47 | 2.84 | 7983.11 |

_Efficiency columns (friction … ms) are means over SUCCESSFUL runs only._

_`tok_in` is TOTAL input including cache reads/writes (the honest context volume); `cached` is the cache-read portion of it. The provider's raw `usage.input` is cache-discounted, so cache-friendly arms would under-report `tok_in` if read raw._

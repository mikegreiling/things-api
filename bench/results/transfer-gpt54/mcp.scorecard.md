# AGENTBENCH scorecard

- git: `1983ea109f96d96d2aac50e4f47b10b6f1453683`
- models: `gpt-5.4`
- prompt hashes: mcp=`e0bc292a876a`
- generated: 2026-07-18T15:09:01.034Z

| arm | model | family | runs | success | safety✗ | friction | tok_in | cached | tok_out | static | dynamic | turns | tools | ms |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| mcp | gpt-5.4 | compound | 9 | 89% | 0 | 0 | 40392.13 | 35968 | 186.13 | 12774.63 | 1656.63 | 3.88 | 3.63 | 10293.5 |
| mcp | gpt-5.4 | discovery | 3 | 100% | 0 | 0 | 19063 | 18090.67 | 49 | 12775 | 782 | 2 | 1 | 4759.67 |
| mcp | gpt-5.4 | domain-reasoning | 9 | 100% | 0 | 0 | 26699.33 | 24689.78 | 78.78 | 12783.67 | 1090.11 | 2.78 | 2.11 | 6189.78 |
| mcp | gpt-5.4 | gui-perception | 12 | 100% | 0 | 0 | 21208.58 | 20138.67 | 53.25 | 12772.25 | 594.92 | 2.25 | 1.25 | 5238.42 |
| mcp | gpt-5.4 | reads | 9 | 100% | 0 | 0.11 | 20185.33 | 18773.33 | 49.44 | 12774 | 867.78 | 2.11 | 1.11 | 4641.56 |
| mcp | gpt-5.4 | recovery-safety | 15 | 100% | 0 | 0.13 | 26526.6 | 25258.67 | 59.93 | 12775.6 | 772.47 | 2.8 | 1.8 | 6035.4 |
| mcp | gpt-5.4 | writes | 24 | 92% | 0 | 0 | 29778.5 | 28369.45 | 74.59 | 12773.86 | 849.36 | 3.14 | 2.14 | 7533.32 |

_Efficiency columns (friction … ms) are means over SUCCESSFUL runs only._

_`tok_in` is TOTAL input including cache reads/writes (the honest context volume); `cached` is the cache-read portion of it. The provider's raw `usage.input` is cache-discounted, so cache-friendly arms would under-report `tok_in` if read raw._

# AGENTBENCH scorecard

- git: `fc096a096cf5ea4dcf574509b9c20c513f369e2f`
- models: `gpt-5.4-mini`
- prompt hashes: cli=`49f40bf36ef0`
- generated: 2026-07-18T04:54:12.468Z

| arm | model | family | runs | success | safety✗ | friction | tok_in | cached | tok_out | static | dynamic | turns | tools | ms |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| cli | gpt-5.4-mini | compound | 9 | 100% | 0 | 1.78 | 31004 | 5575.11 | 346.89 | 280 | 8127.44 | 7.78 | 7.22 | 17512.44 |
| cli | gpt-5.4-mini | discovery | 3 | 100% | 0 | 0 | 3471 | 0 | 86.33 | 280 | 2128.33 | 3 | 2 | 4328.67 |
| cli | gpt-5.4-mini | domain-reasoning | 9 | 0% | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 |
| cli | gpt-5.4-mini | gui-perception | 12 | 42% | 0 | 0.6 | 11658.6 | 307.2 | 164.4 | 280 | 5441.6 | 4.8 | 3.8 | 8764 |
| cli | gpt-5.4-mini | reads | 9 | 78% | 0 | 0.14 | 33291.43 | 12068.57 | 176 | 280 | 13782.71 | 4.71 | 3.71 | 9622.86 |
| cli | gpt-5.4-mini | recovery-safety | 15 | 73% | 0 | 0.55 | 12488 | 1117.09 | 180.36 | 280 | 4627.91 | 5.45 | 4.82 | 10061.45 |
| cli | gpt-5.4-mini | writes | 24 | 88% | 0 | 1 | 20938.1 | 3876.57 | 224.81 | 280 | 6002.86 | 7.38 | 6.43 | 14196.24 |

_Efficiency columns (friction … ms) are means over SUCCESSFUL runs only._

_`tok_in` is TOTAL input including cache reads/writes (the honest context volume); `cached` is the cache-read portion of it. The provider's raw `usage.input` is cache-discounted, so cache-friendly arms would under-report `tok_in` if read raw._

# AGENTBENCH scorecard

- git: `bc2602446a6d8ac389fb311140a3497b4acb0223`
- models: `gpt-5.4`
- prompt hashes: cli=`49f40bf36ef0`
- generated: 2026-07-18T14:42:50.652Z

| arm | model | family | runs | success | safety✗ | friction | tok_in | cached | tok_out | static | dynamic | turns | tools | ms |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| cli | gpt-5.4 | compound | 9 | 100% | 0 | 1.89 | 39686.89 | 27761.78 | 431.11 | 280 | 9915.33 | 7.67 | 8.33 | 22619.33 |
| cli | gpt-5.4 | discovery | 3 | 100% | 0 | 0 | 3183 | 1024 | 85 | 280 | 1969 | 3 | 2 | 5616 |
| cli | gpt-5.4 | domain-reasoning | 9 | 100% | 0 | 0.56 | 18725.44 | 9216 | 298.33 | 280 | 9279.56 | 5.33 | 4.33 | 15257.67 |
| cli | gpt-5.4 | gui-perception | 12 | 83% | 0 | 0.7 | 12833.9 | 7219.2 | 207.5 | 280 | 5128.3 | 5.2 | 4.2 | 14084.5 |
| cli | gpt-5.4 | reads | 9 | 100% | 0 | 0 | 5901.56 | 1991.11 | 127.11 | 280 | 3581 | 3.11 | 2.11 | 8055.89 |
| cli | gpt-5.4 | recovery-safety | 15 | 100% | 0 | 0.93 | 10380.8 | 4881.07 | 184.67 | 280 | 4758.87 | 4.4 | 3.53 | 10780.6 |
| cli | gpt-5.4 | writes | 24 | 96% | 0 | 1.13 | 16349.91 | 10173.22 | 246.26 | 280 | 6214.35 | 5.65 | 4.65 | 14035.65 |

_Efficiency columns (friction … ms) are means over SUCCESSFUL runs only._

_`tok_in` is TOTAL input including cache reads/writes (the honest context volume); `cached` is the cache-read portion of it. The provider's raw `usage.input` is cache-discounted, so cache-friendly arms would under-report `tok_in` if read raw._

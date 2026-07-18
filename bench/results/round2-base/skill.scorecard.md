# AGENTBENCH scorecard

- git: `fc096a096cf5ea4dcf574509b9c20c513f369e2f`
- models: `gpt-5.4-mini`
- prompt hashes: skill=`821c482c690b`
- generated: 2026-07-18T05:11:08.364Z

| arm | model | family | runs | success | safety✗ | friction | tok_in | cached | tok_out | static | dynamic | turns | tools | ms |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| skill | gpt-5.4-mini | compound | 9 | 78% | 0 | 0.86 | 45619.86 | 6290.29 | 524.86 | 4187 | 9966.43 | 7 | 6.43 | 18210.14 |
| skill | gpt-5.4-mini | discovery | 3 | 100% | 0 | 0 | 8656.33 | 0 | 121.67 | 4187 | 4604 | 3 | 2 | 4935 |
| skill | gpt-5.4-mini | domain-reasoning | 9 | 0% | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 |
| skill | gpt-5.4-mini | gui-perception | 12 | 58% | 0 | 0.71 | 20786.71 | 2121.14 | 276.29 | 4187 | 7379.43 | 4.86 | 3.86 | 10426.43 |
| skill | gpt-5.4-mini | reads | 9 | 78% | 0 | 0.14 | 12878 | 1243.43 | 176 | 4187 | 5261.29 | 3.57 | 2.57 | 8364.57 |
| skill | gpt-5.4-mini | recovery-safety | 15 | 100% | 0 | 0.67 | 26581.53 | 4300.8 | 293 | 4187 | 7296.67 | 5.73 | 4.87 | 12262.8 |
| skill | gpt-5.4-mini | writes | 24 | 96% | 0 | 0.83 | 27023.78 | 4608 | 326.52 | 4187 | 6907.48 | 5.7 | 4.87 | 12949.39 |

_Efficiency columns (friction … ms) are means over SUCCESSFUL runs only._

_`tok_in` is TOTAL input including cache reads/writes (the honest context volume); `cached` is the cache-read portion of it. The provider's raw `usage.input` is cache-discounted, so cache-friendly arms would under-report `tok_in` if read raw._

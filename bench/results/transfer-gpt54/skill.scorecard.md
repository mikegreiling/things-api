# AGENTBENCH scorecard

- git: `bc2602446a6d8ac389fb311140a3497b4acb0223`
- models: `gpt-5.4`
- prompt hashes: skill=`821c482c690b`
- generated: 2026-07-18T14:59:07.072Z

| arm | model | family | runs | success | safety✗ | friction | tok_in | cached | tok_out | static | dynamic | turns | tools | ms |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| skill | gpt-5.4 | compound | 9 | 100% | 0 | 0.67 | 20003.22 | 14165.33 | 370.67 | 4187 | 5501.56 | 5.78 | 5.11 | 16336.89 |
| skill | gpt-5.4 | discovery | 3 | 100% | 0 | 0 | 5183 | 2048 | 89 | 4187 | 2769.67 | 3 | 2 | 5255.33 |
| skill | gpt-5.4 | domain-reasoning | 9 | 100% | 0 | 0.33 | 24435.78 | 15815.11 | 295.78 | 4187 | 6269.33 | 5.78 | 4.78 | 15799.56 |
| skill | gpt-5.4 | gui-perception | 12 | 75% | 0 | 0.33 | 10690.89 | 5404.44 | 163.33 | 4187 | 4227.67 | 3.78 | 2.78 | 8630.33 |
| skill | gpt-5.4 | reads | 9 | 100% | 0 | 0.44 | 9319.67 | 5347.56 | 215.67 | 4187 | 3974.44 | 3.78 | 2.78 | 10782.22 |
| skill | gpt-5.4 | recovery-safety | 15 | 100% | 0 | 0.27 | 14436.87 | 8635.73 | 194.67 | 4187 | 4937.4 | 4.47 | 3.47 | 11009.47 |
| skill | gpt-5.4 | writes | 24 | 100% | 0 | 0.33 | 12639.13 | 7744 | 210.75 | 4187 | 4355.58 | 4.42 | 3.46 | 10894.79 |

_Efficiency columns (friction … ms) are means over SUCCESSFUL runs only._

_`tok_in` is TOTAL input including cache reads/writes (the honest context volume); `cached` is the cache-read portion of it. The provider's raw `usage.input` is cache-discounted, so cache-friendly arms would under-report `tok_in` if read raw._

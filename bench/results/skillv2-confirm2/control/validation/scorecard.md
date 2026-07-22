# AGENTBENCH scorecard

- git: `4c49dc08b4b949a35e185af6d91ee0dc94721a01`
- models: `gpt-5.4-mini`
- prompt hashes: skill=`821c482c690b`
- generated: 2026-07-21T20:45:12.285Z

| arm | model | family | runs | success | safety✗ | friction | tok_in | cached | tok_out | static | dynamic | turns | tools | ms |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| skill | gpt-5.4-mini | compound | 10 | 80% | 0 | 1.38 | 46158.88 | 8704 | 529.25 | 4553 | 12141 | 6.75 | 6.38 | 18026.88 |
| skill | gpt-5.4-mini | domain-reasoning | 10 | 0% | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 |
| skill | gpt-5.4-mini | gui-perception | 10 | 10% | 0 | 0 | 14568 | 0 | 243 | 4553 | 5693 | 4 | 4 | 8658 |
| skill | gpt-5.4-mini | longtail | 20 | 60% | 0 | 1.17 | 28145.67 | 5077.33 | 362.5 | 4553 | 7338.42 | 6.08 | 5.08 | 16569.75 |
| skill | gpt-5.4-mini | reads | 10 | 90% | 0 | 0.33 | 17143.89 | 3356.44 | 212.89 | 4553 | 6166.33 | 4.44 | 3.44 | 12284.56 |
| skill | gpt-5.4-mini | recovery-safety | 10 | 100% | 0 | 0.7 | 20375.3 | 2457.6 | 289.5 | 4553 | 5583.2 | 5.4 | 4.5 | 12459.7 |
| skill | gpt-5.4-mini | writes | 10 | 100% | 0 | 0.1 | 13670 | 1382.4 | 207.9 | 4553 | 4818.8 | 4.2 | 3.3 | 9754 |

_Efficiency columns (friction … ms) are means over SUCCESSFUL runs only._

_`tok_in` is TOTAL input including cache reads/writes (the honest context volume); `cached` is the cache-read portion of it. The provider's raw `usage.input` is cache-discounted, so cache-friendly arms would under-report `tok_in` if read raw._

# AGENTBENCH scorecard

- git: `c2bb9a1cb572615b6b148a1d7269f1cd97271b95`
- models: `gpt-5.4-mini`
- prompt hashes: skill=`821c482c690b`
- generated: 2026-07-17T21:59:33.206Z

| arm | model | family | runs | success | safety✗ | friction | tok_in | tok_out | static | dynamic | turns | tools | ms |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| skill | gpt-5.4-mini | compound | 6 | 83% | 0 | 0.4 | 24993.4 | 378.2 | 3674 | 9613.4 | 5.4 | 5 | 15753 |
| skill | gpt-5.4-mini | discovery | 3 | 100% | 0 | 0 | 6495.67 | 139 | 3674 | 3482.67 | 3 | 2 | 6246.67 |
| skill | gpt-5.4-mini | domain-reasoning | 3 | 0% | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 |
| skill | gpt-5.4-mini | gui-perception | 6 | 67% | 0 | 0.75 | 18561.5 | 360 | 3674 | 6493 | 6 | 5 | 15707.5 |
| skill | gpt-5.4-mini | reads | 6 | 83% | 0 | 0 | 9075.8 | 170.6 | 3674 | 4853.2 | 3.2 | 2.2 | 6775.8 |
| skill | gpt-5.4-mini | recovery-safety | 6 | 100% | 0 | 1 | 19200.67 | 229.83 | 3674 | 6252.33 | 5.5 | 4.5 | 11974.67 |
| skill | gpt-5.4-mini | writes | 12 | 100% | 0 | 0.42 | 18738 | 280.08 | 3674 | 6683.67 | 5.17 | 4.17 | 13538.83 |

_Efficiency columns (friction … ms) are means over SUCCESSFUL runs only._

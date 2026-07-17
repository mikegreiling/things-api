# AGENTBENCH scorecard

- git: `c2bb9a1cb572615b6b148a1d7269f1cd97271b95`
- models: `gpt-5.4-mini`
- prompt hashes: cli=`49f40bf36ef0`
- generated: 2026-07-17T21:50:44.034Z

| arm | model | family | runs | success | safety✗ | friction | tok_in | tok_out | static | dynamic | turns | tools | ms |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| cli | gpt-5.4-mini | compound | 6 | 50% | 0 | 0 | 13321.67 | 174.33 | 280 | 7174 | 4 | 4.33 | 9612.67 |
| cli | gpt-5.4-mini | discovery | 3 | 100% | 0 | 0 | 3185.33 | 81.67 | 280 | 1990.67 | 3 | 2 | 5132.33 |
| cli | gpt-5.4-mini | domain-reasoning | 3 | 0% | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 |
| cli | gpt-5.4-mini | gui-perception | 6 | 50% | 0 | 0 | 6043.33 | 129.67 | 280 | 2940.67 | 4 | 3 | 7478.33 |
| cli | gpt-5.4-mini | reads | 6 | 33% | 0 | 1 | 16844 | 518 | 280 | 6251.5 | 8 | 7 | 20745.5 |
| cli | gpt-5.4-mini | recovery-safety | 6 | 83% | 0 | 0.8 | 7594.2 | 148.2 | 280 | 3124.6 | 4.8 | 3.8 | 9424 |
| cli | gpt-5.4-mini | writes | 12 | 75% | 0 | 1.56 | 17425 | 245.67 | 280 | 6453.11 | 7 | 6 | 15912.44 |

_Efficiency columns (friction … ms) are means over SUCCESSFUL runs only._

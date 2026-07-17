# AGENTBENCH scorecard

- git: `c2bb9a1cb572615b6b148a1d7269f1cd97271b95`
- models: `gpt-5.4-mini`
- prompt hashes: mcp=`4d3967419427`
- generated: 2026-07-17T22:05:30.681Z

| arm | model | family | runs | success | safety✗ | friction | tok_in | tok_out | static | dynamic | turns | tools | ms |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| mcp | gpt-5.4-mini | compound | 6 | 50% | 0 | 0.67 | 4621 | 219.33 | 16617.33 | 2118 | 5 | 5.67 | 14133.67 |
| mcp | gpt-5.4-mini | discovery | 3 | 67% | 0 | 0 | 2003 | 49 | 16616 | 787 | 2 | 1 | 5023.5 |
| mcp | gpt-5.4-mini | domain-reasoning | 3 | 0% | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 |
| mcp | gpt-5.4-mini | gui-perception | 6 | 50% | 0 | 0.67 | 54210 | 133.67 | 16613 | 22800.33 | 3 | 5 | 11288.67 |
| mcp | gpt-5.4-mini | reads | 6 | 67% | 0 | 0.75 | 2183.25 | 69.25 | 16613.5 | 862 | 2.75 | 1.75 | 7222.25 |
| mcp | gpt-5.4-mini | recovery-safety | 6 | 83% | 0 | 0.2 | 1992 | 61.2 | 16617.6 | 797.4 | 2.6 | 1.8 | 6162 |
| mcp | gpt-5.4-mini | writes | 12 | 75% | 0 | 0.89 | 2514.67 | 84.56 | 16614.33 | 977 | 3.67 | 2.78 | 8616.44 |

_Efficiency columns (friction … ms) are means over SUCCESSFUL runs only._

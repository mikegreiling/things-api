# AGENTBENCH scorecard

- git: `fc096a096cf5ea4dcf574509b9c20c513f369e2f`
- models: `gpt-5.4-mini`
- prompt hashes: mcp=`12d2f291e0d5`
- generated: 2026-07-18T05:21:46.400Z

| arm | model | family | runs | success | safety✗ | friction | tok_in | cached | tok_out | static | dynamic | turns | tools | ms |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| mcp | gpt-5.4-mini | compound | 9 | 100% | 0 | 0.78 | 51638 | 32711.11 | 155 | 16806.67 | 1452 | 4.22 | 4 | 10121 |
| mcp | gpt-5.4-mini | discovery | 3 | 100% | 0 | 0 | 24079 | 21674.67 | 49 | 16807 | 783.67 | 2 | 1 | 4525.33 |
| mcp | gpt-5.4-mini | domain-reasoning | 9 | 0% | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 |
| mcp | gpt-5.4-mini | gui-perception | 12 | 50% | 0 | 0.17 | 31885.83 | 27989.33 | 65.33 | 16804.83 | 717.5 | 2.67 | 1.67 | 5506.67 |
| mcp | gpt-5.4-mini | reads | 9 | 78% | 0 | 0.14 | 26048 | 23625.14 | 57.57 | 16807.29 | 1069.29 | 2.14 | 1.14 | 4089.86 |
| mcp | gpt-5.4-mini | recovery-safety | 15 | 100% | 0 | 0.33 | 35423.53 | 32221.87 | 81.2 | 16808.2 | 1042.6 | 2.93 | 2.53 | 7286.67 |
| mcp | gpt-5.4-mini | writes | 24 | 88% | 0 | 0.52 | 47766.05 | 43227.43 | 105.29 | 16806.33 | 1328.29 | 3.9 | 3.33 | 9059.38 |

_Efficiency columns (friction … ms) are means over SUCCESSFUL runs only._

_`tok_in` is TOTAL input including cache reads/writes (the honest context volume); `cached` is the cache-read portion of it. The provider's raw `usage.input` is cache-discounted, so cache-friendly arms would under-report `tok_in` if read raw._

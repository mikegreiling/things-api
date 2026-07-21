# AGENTBENCH scorecard

- git: `d1b4eb83573fc3030f67de2e579d9580d7912a90`
- models: `gpt-5.4-mini`
- prompt hashes: skill=`821c482c690b`
- generated: 2026-07-21T08:19:50.078Z

| arm | model | family | runs | success | safety✗ | friction | tok_in | cached | tok_out | static | dynamic | turns | tools | ms |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| skill | gpt-5.4-mini | compound | 10 | 100% | 0 | 0.5 | 30178.2 | 2099.2 | 351.6 | 4553 | 9316.9 | 5.8 | 5.3 | 15222.9 |
| skill | gpt-5.4-mini | gui-perception | 10 | 80% | 0 | 1.13 | 28699.5 | 7424 | 411.25 | 4553 | 7309.38 | 6.13 | 5.13 | 14717.38 |
| skill | gpt-5.4-mini | longtail | 10 | 100% | 0 | 1.1 | 20151.4 | 2764.8 | 266.6 | 4553 | 5735.3 | 5.5 | 4.5 | 14335.5 |
| skill | gpt-5.4-mini | writes | 10 | 100% | 0 | 0.9 | 29981.2 | 3993.6 | 255.1 | 4553 | 7126.4 | 6.5 | 5.5 | 14139.8 |

_Efficiency columns (friction … ms) are means over SUCCESSFUL runs only._

_`tok_in` is TOTAL input including cache reads/writes (the honest context volume); `cached` is the cache-read portion of it. The provider's raw `usage.input` is cache-discounted, so cache-friendly arms would under-report `tok_in` if read raw._

# hfix.sh <prefix> — synthetic project with two headings + a child under H1 (guest-side fixture)
source ~/g.sh
T="$1"
js='[{"type":"project","attributes":{"title":"'"$T"'-HP","items":[{"type":"heading","attributes":{"title":"'"$T"'-HP-H1"}},{"type":"to-do","attributes":{"title":"'"$T"'-HP-H1-CHILD"}},{"type":"heading","attributes":{"title":"'"$T"'-HP-H2"}}]}}]'
enc=$(python3 -c 'import sys,urllib.parse;print(urllib.parse.quote(sys.argv[1],safe=""))' "$js")
open -g "things:///json?data=$enc"
for i in 1 2 3 4 5 6 7 8 9 10; do [ -n "$(uuid_of "$T-HP-H1-CHILD")" ] && break; sleep 1; done
echo "HP=$(uuid_of "$T-HP") H1=$(uuid_of "$T-HP-H1")"

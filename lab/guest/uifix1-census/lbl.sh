# lbl.sh <n> — sample the Repeat submenu's toggle label n times, ~each 250ms, by NAME lookup only
n=${1:-20}
for i in $(seq 1 $n); do
  osascript -e 'tell application "System Events" to tell process "Things3"
set m to menu 1 of menu item "Repeat" of menu "Items" of menu bar 1
set a to exists menu item "Pause" of m
set b to exists menu item "Resume" of m
return (a as text) & "/" & (b as text)
end tell' 2>&1 | tr '\n' ' '
  echo " t=$(python3 -c 'import time;print(int(time.time()*1000)%100000)')"
  sleep 0.25
done

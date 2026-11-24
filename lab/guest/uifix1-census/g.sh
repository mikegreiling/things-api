# sourced in the guest
export THINGS_API_UI_DIRECT=1 THINGS_API_WRITE_DIRECT=1 THINGS_API_NO_HELPERS_CHECK=1 NODE_NO_WARNINGS=1
things() { ~/things-lab/bin/node ~/things-lab/things-api/dist/cli/main.js "$@"; }
cx() { osascript -l JavaScript ~/cx.jxa "$@"; }
dbq() {
  python3 -c "
import glob, os, sqlite3, sys
db = glob.glob(os.path.expanduser('~/Library/Group Containers/JLMPQHK86H.com.culturedcode.ThingsMac/ThingsData-*/Things Database.thingsdatabase/main.sqlite'))[0]
c = sqlite3.connect(f'file:{db}?mode=ro', uri=True)
for row in c.execute(sys.argv[1]).fetchall():
    print('|'.join('' if v is None else str(v) for v in row))
" "$1"
}
uuid_of() { dbq "SELECT uuid FROM TMTask WHERE title='$1' AND trashed=0 ORDER BY creationDate DESC LIMIT 1"; }
tmpl_of() { dbq "SELECT uuid FROM TMTask WHERE title='$1' AND trashed=0 AND rt1_recurrenceRule IS NOT NULL LIMIT 1"; }
paused() { dbq "SELECT rt1_instanceCreationPaused FROM TMTask WHERE uuid='$1'"; }

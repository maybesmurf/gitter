#!/bin/bash
set -e
set -x

SCRIPT_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"

# For any room we see getting large, remove their old users.
# As the users grow to our performance limits we have hit in the past,
# be more aggressive at removing the users.
#
# See https://gitlab.com/gitterHQ/gitter-infrastructure/-/issues/204

/usr/bin/ns $SCRIPT_DIR/../utils/auto-remove-from-room.js --members 25000 --min 500

/usr/bin/ns $SCRIPT_DIR/../utils/auto-remove-from-room.js --members 30000 --min 365

/usr/bin/ns $SCRIPT_DIR/../utils/auto-remove-from-room.js --members 35000 --min 90

/usr/bin/ns $SCRIPT_DIR/../utils/auto-remove-from-room.js --members 40000 --min 14

/usr/bin/ns $SCRIPT_DIR/../utils/auto-remove-from-room.js --members 45000 --min 2

CHECK_FOR_OVERFLOW_COMMAND_OUTPUT=$(/usr/bin/ns $SCRIPT_DIR/../utils/auto-remove-from-room.js --members 45000 --dryRun | tail -1)
if [ "$CHECK_FOR_OVERFLOW_COMMAND_OUTPUT" != "Completed after removing 0 users." ]; then
  /usr/local/bin/pagerduty-trigger --description "Found a Gitter room that is too large even after running the trim-large-rooms cron.\n$CHECK_FOR_OVERFLOW_COMMAND_OUTPUT" --error gitter_room_too_large
else
  echo "Success: No large rooms found :)"
  /usr/local/bin/pagerduty-resolve --error gitter_room_too_large
fi

#!/bin/sh
# Send a media URL to the Canvas Display DLNA renderer via UPnP AVTransport.
#
# Usage: dlna-play.sh <url> [renderer-base-url]
#   renderer-base-url defaults to http://127.0.0.1:49500
#
# Example:
#   ./dlna-play.sh http://192.168.1.108:8001/tuner1.mp3
#   ./dlna-play.sh http://host/clip.mp4 http://192.168.1.216:49500
set -eu

URL="${1:?usage: dlna-play.sh <url> [renderer-base-url]}"
BASE="${2:-http://127.0.0.1:49500}"
CTRL="$BASE/control/AVTransport"
AVT="urn:schemas-upnp-org:service:AVTransport:1"

soap() {
  # $1 = action, $2 = inner XML
  cat <<EOF
<?xml version="1.0" encoding="utf-8"?>
<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/" s:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/">
<s:Body><u:$1 xmlns:u="$AVT">$2</u:$1></s:Body></s:Envelope>
EOF
}

call() {
  # $1 = action, $2 = inner XML
  soap "$1" "$2" > /tmp/canvas-dlna-soap.xml
  curl -s -m 15 -X POST "$CTRL" \
    -H 'Content-Type: text/xml; charset="utf-8"' \
    -H "SOAPAction: \"$AVT#$1\"" \
    --data-binary @/tmp/canvas-dlna-soap.xml -o /tmp/canvas-dlna-soap-resp.xml \
    -w "%{http_code}"
}

echo -n "SetAVTransportURI="
call SetAVTransportURI "<InstanceID>0</InstanceID><CurrentURI>$URL</CurrentURI><CurrentURIMetaData></CurrentURIMetaData>"
echo

echo -n "Play="
call Play "<InstanceID>0</InstanceID><Speed>1</Speed>"
echo

sleep 2
echo "--- renderer state ---"
curl -s -m 10 "$BASE/health"
echo
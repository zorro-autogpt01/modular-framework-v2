# ./splunk/Dockerfile
FROM splunk/splunk:latest

# Splunk 10.x images require both license + general terms acceptance
ENV SPLUNK_START_ARGS="--accept-license" \
    SPLUNK_GENERAL_TERMS="--accept-sgt-current-at-splunk-com"

# You MUST set SPLUNK_PASSWORD at runtime (docker run -e SPLUNK_PASSWORD=...)
# We do NOT copy any secrets (like HEC token) into the image.
# Mount your HEC app config into /opt/splunk/etc/apps/hec/local at runtime.

# Expose common ports
# 8000 = Splunk Web UI, 8088 = HEC, 8089 = Management, 9997 = forwarders (optional)
EXPOSE 8000 8088 8089 9997

# Nothing else to run here; the upstream entrypoint handles boot

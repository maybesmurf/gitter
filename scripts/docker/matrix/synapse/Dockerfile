# From https://hub.docker.com/layers/matrixdotorg/synapse/v1.72.0/images/sha256-d0f0fd204b8183ac6f4c2253f5a571e797785c5496b3b7f302c5abf639af4c95?context=explore
FROM matrixdotorg/synapse:v1.72.0

COPY --chown=991:991 data /data/

EXPOSE 8008/tcp

ENTRYPOINT ["/start.py"]

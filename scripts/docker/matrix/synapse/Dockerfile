# From https://hub.docker.com/layers/matrixdotorg/synapse/v1.32.2/images/sha256-2e2cf255e5440c33bbf61a71a743cdc2237f022c68552ecda6be1e5acd41700e?context=explore
FROM matrixdotorg/synapse:v1.32.2

COPY --chown=991:991 data /data/

EXPOSE 8008/tcp

ENTRYPOINT ["/start.py"]

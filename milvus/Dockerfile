FROM milvusdb/milvus:v2.4.13

EXPOSE 19530 9091 2379

ENV ETCD_USE_EMBED=true
ENV ETCD_DATA_DIR=/var/lib/milvus/etcd
ENV ETCD_CONFIG_PATH=/milvus/configs/embedEtcd.yaml
ENV COMMON_STORAGETYPE=local

RUN echo "listen-client-urls: http://0.0.0.0:2379" > /milvus/configs/embedEtcd.yaml && \
    echo "advertise-client-urls: http://0.0.0.0:2379" >> /milvus/configs/embedEtcd.yaml && \
    echo "quota-backend-bytes: 4294967296" >> /milvus/configs/embedEtcd.yaml && \
    echo "auto-compaction-mode: revision" >> /milvus/configs/embedEtcd.yaml && \
    echo "auto-compaction-retention: '1000'" >> /milvus/configs/embedEtcd.yaml

RUN echo "# Extra config to override default milvus.yaml" > /milvus/configs/user.yaml

HEALTHCHECK --interval=30s --timeout=20s --start-period=90s --retries=3 \
  CMD curl -f http://localhost:9091/healthz || exit 1

CMD ["milvus", "run", "standalone"]
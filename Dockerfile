FROM golang:1.25-alpine AS builder
WORKDIR /app
COPY api-go/go.mod api-go/go.sum ./
RUN go mod download
COPY api-go/ .
RUN CGO_ENABLED=0 GOOS=linux go build -ldflags="-s -w" -o /mote ./cmd/server

FROM alpine:latest
RUN apk --no-cache add ca-certificates tzdata
RUN addgroup -S mote && adduser -S -G mote mote
WORKDIR /opt/mote
COPY --from=builder /mote ./mote
RUN mkdir -p /data /uploads && chown -R mote:mote /opt/mote /data /uploads
USER mote
EXPOSE 8000
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD wget -qO- http://localhost:8000/health | grep -q healthy
CMD ["./mote"]

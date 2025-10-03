FROM nginx:alpine
RUN apk add --no-cache openssl curl && mkdir -p /etc/nginx/certs
COPY nginx.conf /etc/nginx/nginx.conf
RUN openssl req -x509 -nodes -newkey rsa:2048 \
    -keyout /etc/nginx/certs/dev.key \
    -out /etc/nginx/certs/dev.crt \
    -days 365 -subj "/CN=localhost" \
    -addext "subjectAltName=DNS:localhost,IP:127.0.0.1,DNS:edge-nginx"
EXPOSE 80 443
CMD ["nginx", "-g", "daemon off;"]
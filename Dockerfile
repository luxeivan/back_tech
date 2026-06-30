FROM ubuntu:20.04

ENV DEBIAN_FRONTEND=noninteractive

RUN apt-get update && apt-get install -y \
    curl \
    libengine-gost-openssl1.1 \
    openssl \
    ca-certificates \
    gnupg \
    && rm -rf /var/lib/apt/lists/*

# Configure OpenSSL GOST engine
RUN GOST_SO=$(find /usr/lib -name "gost.so" | head -1) && \
    cat > /etc/ssl/openssl.cnf <<EOF
openssl_conf = openssl_def

[openssl_def]
engines = engine_section
ssl_conf = ssl_sect

[engine_section]
gost = gost_section

[gost_section]
dynamic_path = ${GOST_SO}
default_algorithms = ALL
CRYPT_PARAMS = id-Gost28147-89-CryptoPro-A-ParamSet

[ssl_sect]
system_default = system_default_sect

[system_default_sect]
CipherString = DEFAULT:@SECLEVEL=0
EOF

# Install Node.js 22
RUN curl -fsSL https://deb.nodesource.com/setup_22.x | bash - && \
    apt-get install -y nodejs && \
    rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm install --production

COPY . .

EXPOSE 3110

CMD ["node", "app.js"]

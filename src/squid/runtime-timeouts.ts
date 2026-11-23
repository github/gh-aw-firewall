export const RUNTIME_TIMEOUTS = `# Timeout settings for streaming/long-lived connections (AI inference APIs)
# read_timeout: Time to wait for data from server before giving up
# Increased to accommodate long AI inference calls and SSE streaming
read_timeout 30 minutes

# connect_timeout: Time to wait for TCP connection to origin server
connect_timeout 30 seconds

# request_timeout: Time to wait for client to send first request after connection
request_timeout 2 minutes

# persistent_request_timeout: Time to wait for next request on persistent connection
persistent_request_timeout 2 minutes

# pconn_timeout: How long to keep idle persistent connections to servers
pconn_timeout 2 minutes

# client_lifetime: Maximum time a client connection can be open
# Set high to accommodate long streaming sessions
client_lifetime 8 hours

# Close clients that send EOF before the TLS ClientHello to avoid Squid's
# empty-buffer assertion during ssl_bump peek. CONNECT tunnels handle half-close
# themselves, and SSE does not require a TCP half-close.
half_closed_clients off

# shutdown_lifetime: Time to wait for active connections during shutdown
# Set to 0 because this is an ephemeral proxy — no connection draining needed
shutdown_lifetime 0 seconds

# Debugging (can be enabled for troubleshooting)
# debug_options ALL,1 33,2
`;

import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';

const openapi = await readFile(new URL('../openapi/openapi.yaml', import.meta.url), 'utf8');

createServer((request, response) => {
  response.setHeader('cache-control', 'no-store');
  response.setHeader('x-content-type-options', 'nosniff');
  if (request.url === '/healthz') {
    response.setHeader('content-type', 'application/json');
    response.end(JSON.stringify({ status: 'ok' }));
    return;
  }
  if (request.url === '/openapi.yaml') {
    response.setHeader('content-type', 'application/yaml');
    response.end(openapi);
    return;
  }
  if (request.url === '/v2/health/ready') {
    response.setHeader('server', 'triton-inference-server');
    response.setHeader('content-type', 'application/json');
    response.end(JSON.stringify({ ready: true, release: 'fixed' }));
    return;
  }
  if (request.url === '/admin/status') {
    response.statusCode = 401;
    response.setHeader('content-type', 'application/json');
    response.end(JSON.stringify({ error: 'authentication required' }));
    return;
  }
  response.setHeader('content-type', 'application/json');
  response.end(JSON.stringify({ service: 'controlled-fixed', status: 'ok' }));
}).listen(8080, '0.0.0.0');

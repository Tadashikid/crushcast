import { lanUrl, startServer } from './server';

const port = Number(process.env.PORT ?? 8080);
const { port: actual } = await startServer({ port }).catch((err: NodeJS.ErrnoException) => {
  if (err.code !== 'EADDRINUSE') throw err;
  console.error(`Port ${port} is already in use — another CrushCast server is probably running. Stop it, or run with PORT=8081.`);
  process.exit(1);
});
console.log(`CrushCast server on :${actual}`);
console.log(`  control (this laptop only): http://localhost:${actual}/`);
console.log(`  phones:                      ${process.env.PUBLIC_URL ?? lanUrl(actual)}/join`);
if (!process.env.PUBLIC_URL) console.log('  tip: cloudflared tunnel --url http://localhost:8080, then restart with PUBLIC_URL=<https url>');

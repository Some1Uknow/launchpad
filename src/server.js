const app = require('./app');
const { prisma } = require('./lib/prisma');

const PORT = 3000;

async function main() {
  const server = app.listen(PORT, () => {
    console.info(`Server listening on port ${PORT}`);
  });

  const shutdown = async () => {
    await prisma.$disconnect();
    server.close(() => process.exit(0));
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((error) => {
  console.error('Failed to start server', error);
  process.exit(1);
});

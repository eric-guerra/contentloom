/** @type {import('next').NextConfig} */
module.exports = { async rewrites() { return [{ source: '/api/:path*', destination: (process.env.CONTENTLOOM_API ?? 'http://localhost:3001') + '/:path*' }]; } };

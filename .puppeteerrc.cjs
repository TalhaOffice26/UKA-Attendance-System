const { join } = require('path');

/**
 * @type {import("puppeteer").Configuration}
 */
module.exports = {
  // প্রজেক্টের ভেতরেই ক্রোম ক্যাশ রাখা হবে যেন রেন্ডার রানটাইমে মুছে না যায়
  cacheDirectory: join(__dirname, '.cache', 'puppeteer'),
};
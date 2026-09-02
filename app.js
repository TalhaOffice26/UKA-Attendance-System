require('dotenv').config();
const express = require('express');
const session = require('express-session');
const mongoose = require('mongoose');
const path = require('path');
const fs = require('fs');
const { Client, LocalAuth } = require('whatsapp-web.js');
const QRCode = require('qrcode');

const Batch = require('./models/Batch');
const Student = require('./models/Student');
const Attendance = require('./models/Attendance');

const app = express();

// MongoDB Connection
const mongoURI = process.env.MONGODB_URI;
mongoose.connect(mongoURI)
  .then(() => console.log('MongoDB Atlas Connected Successfully!'))
  .catch(err => console.error('MongoDB Connection Error:', err));

// ================= WhatsApp Web State & Client Setup =================
let isWhatsAppReady = false;
let currentQRCodeDataUrl = null;

// প্রজেক্ট ক্যাশ ও লিনাক্স ডিরেক্টরি থেকে ক্রোম পাথ খোঁজা
function getExecutablePath() {
  if (process.env.PUPPETEER_EXECUTABLE_PATH && fs.existsSync(process.env.PUPPETEER_EXECUTABLE_PATH)) {
    return process.env.PUPPETEER_EXECUTABLE_PATH;
  }

  const localCachePath = path.join(__dirname, '.cache', 'puppeteer', 'chrome');
  if (fs.existsSync(localCachePath)) {
    try {
      const versions = fs.readdirSync(localCachePath);
      for (const ver of versions) {
        const candidate = path.join(localCachePath, ver, 'chrome-linux64', 'chrome');
        if (fs.existsSync(candidate)) return candidate;
      }
    } catch (e) {
      console.warn('Error reading local puppeteer cache:', e.message);
    }
  }

  const fallbackPaths = [
    '/opt/render/.cache/puppeteer/chrome/linux-146.0.7680.31/chrome-linux64/chrome',
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium-browser',
    '/usr/bin/chromium'
  ];

  return fallbackPaths.find(p => p && fs.existsSync(p)) || null;
}

const browserPath = getExecutablePath();
console.log('Detected Browser Executable Path:', browserPath || 'Default Puppeteer Path');

const waClient = new Client({
  authStrategy: new LocalAuth({ 
    clientId: "uka_session",
    dataPath: path.join(__dirname, '.wwebjs_auth')
  }),
  puppeteer: {
    headless: true,
    ...(browserPath ? { executablePath: browserPath } : {}),
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-accelerated-2d-canvas',
      '--no-first-run',
      '--no-zygote',
      '--single-process',
      '--disable-gpu',
      '--disable-extensions',
      '--disable-default-apps',
      '--mute-audio',
      '--js-flags=--max-old-space-size=256'
    ]
  }
});

// কিউআর কোড পাওয়ার ইভেন্ট
waClient.on('qr', async (qr) => {
  try {
    currentQRCodeDataUrl = await QRCode.toDataURL(qr, {
      margin: 2,
      width: 280
    });
    isWhatsAppReady = false;
    console.log('📱 New WhatsApp QR Code generated for web portal.');
  } catch (err) {
    console.error('QR generation error:', err);
  }
});

// অথেনটিকেশন সফল হওয়া মাত্রই কিউআর কোড রিমুভ ও স্টেট একটিভ
waClient.on('authenticated', () => {
  console.log('🔐 WhatsApp Authenticated successfully!');
  currentQRCodeDataUrl = null;
  isWhatsAppReady = true;
});

// হোয়াটসঅ্যাপ ড্যাশবোর্ড রেডি হওয়া
waClient.on('ready', () => {
  isWhatsAppReady = true;
  currentQRCodeDataUrl = null;
  console.log('\n✅ WhatsApp Connected & Ready to send Attendance Alerts!\n');
});

// লোডিং স্ক্রিন
waClient.on('loading_screen', (percent, message) => {
  console.log(`⏳ WhatsApp Loading: ${percent}% - ${message}`);
  currentQRCodeDataUrl = null;
  isWhatsAppReady = true;
});

waClient.on('auth_failure', () => {
  isWhatsAppReady = false;
  currentQRCodeDataUrl = null;
  console.error('❌ WhatsApp Auth Failure');
});

waClient.on('disconnected', (reason) => {
  isWhatsAppReady = false;
  currentQRCodeDataUrl = null;
  console.log('⚠️ WhatsApp Disconnected:', reason);
  waClient.initialize().catch(err => console.error('Re-init error:', err));
});

waClient.initialize().catch(err => {
  console.error('Initial WhatsApp launch error:', err);
});

// Helper: BD Phone Number to WhatsApp ID Formatter
function formatToWhatsAppId(phone) {
  if (!phone) return null;
  let cleaned = phone.replace(/[^0-9]/g, '');
  if (cleaned.startsWith('01')) {
    cleaned = '88' + cleaned;
  } else if (cleaned.startsWith('1')) {
    cleaned = '880' + cleaned;
  }
  return cleaned + '@c.us';
}
// ==============================================================

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use(express.static(__dirname));

// Session Middleware Configuration
app.use(session({
  secret: process.env.SESSION_SECRET || 'uka_secure_attendance_session_secret_2026',
  resave: false,
  saveUninitialized: false,
  cookie: { 
    maxAge: 1000 * 60 * 60 * 24
  }
}));

// Route Protection Middleware
function isAuthenticated(req, res, next) {
  if (req.session && req.session.isAdmin) {
    return next();
  }
  res.redirect('/login');
}

const CATEGORIES = [
  "Junior Spoken English",
  "IELTS Batches",
  "Spoken Phonetics Batches"
];

// ================= Authentication Routes =================
app.get('/login', (req, res) => {
  if (req.session && req.session.isAdmin) {
    return res.redirect('/');
  }
  res.render('login', { error: null });
});

app.post('/login', (req, res) => {
  const username = (req.body.username || '').trim();
  const password = (req.body.password || '').trim();
  const adminUser = (process.env.ADMIN_USER || 'admin').trim();
  const adminPass = (process.env.ADMIN_PASSWORD || 'ukatech@#').trim();

  if (username === adminUser && password === adminPass) {
    req.session.isAdmin = true;
    return res.redirect('/');
  }
  res.render('login', { error: 'ভুল ইউজারনেম অথবা পাসওয়ার্ড!' });
});

app.get('/logout', (req, res) => {
  req.session.destroy(() => {
    res.redirect('/login');
  });
});
// =========================================================

// WhatsApp Status API for Frontend AJAX Polling
app.get('/whatsapp/status', isAuthenticated, (req, res) => {
  res.json({
    connected: isWhatsAppReady,
    qrCode: currentQRCodeDataUrl
  });
});

// WhatsApp Logout Endpoint
app.post('/whatsapp/logout', isAuthenticated, async (req, res) => {
  try {
    if (isWhatsAppReady) {
      await waClient.logout();
    }
    isWhatsAppReady = false;
    currentQRCodeDataUrl = null;
    res.redirect('/');
  } catch (err) {
    res.redirect('/');
  }
});

// WhatsApp Cache & Session Reset Endpoint
app.post('/whatsapp/reset-cache', isAuthenticated, async (req, res) => {
  try {
    console.log('🔄 Clearing WhatsApp Cache & Session via Web Panel...');
    
    try {
      await waClient.destroy();
    } catch (e) {
      console.warn('Client destroy error:', e.message);
    }

    isWhatsAppReady = false;
    currentQRCodeDataUrl = null;

    const authDir = path.join(__dirname, '.wwebjs_auth');
    const cacheDir = path.join(__dirname, '.wwebjs_cache');

    if (fs.existsSync(authDir)) fs.rmSync(authDir, { recursive: true, force: true });
    if (fs.existsSync(cacheDir)) fs.rmSync(cacheDir, { recursive: true, force: true });

    waClient.initialize().catch(err => console.error('Re-init on reset error:', err));

    console.log('✅ WhatsApp Cache cleared and re-initialized!');
    res.redirect('/');
  } catch (err) {
    console.error('Failed to reset cache:', err);
    res.status(500).send('Cache reset failed: ' + err.message);
  }
});

// ১. ড্যাশবোর্ড + লিডারবোর্ড
app.get('/', isAuthenticated, async (req, res) => {
  try {
    const selectedCategory = req.query.category || 'All';
    const filter = selectedCategory === 'All' ? {} : { category: selectedCategory };
    const batches = await Batch.find(filter).sort({ createdAt: -1 });
    const allBatches = await Batch.find().sort({ createdAt: -1 });
    const totalStudentsCount = await Student.countDocuments();

    // Leaderboard Calculation
    const allStudents = await Student.find().populate('batch');
    const allAttendances = await Attendance.find();

    const leaderboard = allStudents.map(student => {
      if (!student.batch) return null;
      
      const studentBatchId = student.batch._id.toString();
      const batchRecords = allAttendances.filter(a => a.batch.toString() === studentBatchId);
      const completedClassesCount = new Set(batchRecords.map(a => a.classNumber)).size;

      const studentRecords = batchRecords.filter(a => a.student.toString() === student._id.toString());
      const presentDays = studentRecords.filter(a => a.status === 'Present').length;
      const percentage = completedClassesCount > 0 ? Math.round((presentDays / completedClassesCount) * 100) : 0;

      return {
        id: student._id,
        name: student.name,
        batchName: student.batch.name,
        category: student.batch.category,
        presentDays,
        totalHeldClasses: completedClassesCount,
        percentage
      };
    })
    .filter(item => item !== null && item.totalHeldClasses > 0)
    .sort((a, b) => b.percentage - a.percentage || b.presentDays - a.presentDays)
    .slice(0, 5);

    res.render('dashboard', { 
      batches, 
      allBatches, 
      categories: CATEGORIES, 
      selectedCategory,
      totalStudentsCount,
      leaderboard,
      isWhatsAppReady
    });
  } catch (error) {
    res.status(500).send('Error loading dashboard: ' + error.message);
  }
});

// ২. ব্যাচ তৈরি
app.post('/batch/create', isAuthenticated, async (req, res) => {
  try {
    const { name, category, totalClasses, teacherName, teacherPhone } = req.body;
    await Batch.create({
      name,
      category,
      totalClasses: totalClasses ? Number(totalClasses) : 40,
      teacherName: teacherName || '',
      teacherPhone: teacherPhone || ''
    });
    res.redirect('/');
  } catch (error) {
    res.status(500).send('Error creating batch: ' + error.message);
  }
});

// ৩. ব্যাচ আপডেট
app.post('/batch/edit/:id', isAuthenticated, async (req, res) => {
  try {
    const { name, category, totalClasses, teacherName, teacherPhone } = req.body;
    await Batch.findByIdAndUpdate(req.params.id, {
      name,
      category,
      totalClasses: totalClasses ? Number(totalClasses) : 40,
      teacherName: teacherName || '',
      teacherPhone: teacherPhone || ''
    });
    res.redirect(`/batch/${req.params.id}`);
  } catch (error) {
    res.status(500).send('Error updating batch: ' + error.message);
  }
});

// ৪. ব্যাচ ডিলিট
app.post('/batch/delete/:id', isAuthenticated, async (req, res) => {
  try {
    const batchId = req.params.id;
    await Batch.findByIdAndDelete(batchId);
    await Student.deleteMany({ batch: batchId });
    await Attendance.deleteMany({ batch: batchId });
    res.redirect('/');
  } catch (error) {
    res.status(500).send('Error deleting batch: ' + error.message);
  }
});

// ৫. ব্যাচ ডিটেইলস
app.get('/batch/:id', isAuthenticated, async (req, res) => {
  try {
    const batch = await Batch.findById(req.params.id);
    if (!batch) return res.redirect('/');
    const students = await Student.find({ batch: req.params.id }).sort({ createdAt: 1 });

    const attendanceRecords = await Attendance.find({ batch: req.params.id });
    const completedClassesMap = {};
    attendanceRecords.forEach(record => {
      completedClassesMap[record.classNumber] = record.date;
    });

    res.render('batch_details', { 
      batch, 
      students, 
      categories: CATEGORIES,
      completedClassesMap,
      isWhatsAppReady
    });
  } catch (error) {
    res.status(500).send('Error loading batch: ' + error.message);
  }
});

// ৬. স্টুডেন্ট যোগ
app.post('/student/add', isAuthenticated, async (req, res) => {
  try {
    const { batch_id, name, phone } = req.body;
    await Student.create({ batch: batch_id, name, phone });
    res.redirect(`/batch/${batch_id}`);
  } catch (error) {
    res.status(500).send('Error adding student: ' + error.message);
  }
});

// ৭. স্টুডেন্ট এডিট
app.post('/student/edit/:id', isAuthenticated, async (req, res) => {
  try {
    const { batch_id, name, phone } = req.body;
    await Student.findByIdAndUpdate(req.params.id, { name, phone });
    res.redirect(`/batch/${batch_id}`);
  } catch (error) {
    res.status(500).send('Error updating student: ' + error.message);
  }
});

// ৮. স্টুডেন্ট ডিলিট
app.post('/student/delete/:id', isAuthenticated, async (req, res) => {
  try {
    const { batch_id } = req.body;
    await Student.findByIdAndDelete(req.params.id);
    await Attendance.deleteMany({ student: req.params.id });
    res.redirect(`/batch/${batch_id}`);
  } catch (error) {
    res.status(500).send('Error deleting student: ' + error.message);
  }
});

// ৯. ক্লাসের হাজিরা পেজ
app.get('/attendance/:batch_id/:class_number', isAuthenticated, async (req, res) => {
  try {
    const { batch_id, class_number } = req.params;
    const msgSentStatus = req.query.msg_sent === 'true';

    const batch = await Batch.findById(batch_id);
    if (!batch) return res.redirect('/');

    const students = await Student.find({ batch: batch_id }).sort({ createdAt: 1 });
    const existingRecords = await Attendance.find({ batch: batch_id, classNumber: Number(class_number) });

    const attendanceMap = {};
    let savedDate = '';
    let alreadyAlertSent = false;

    existingRecords.forEach(r => {
      attendanceMap[r.student.toString()] = r.status;
      savedDate = r.date;
      if (r.isAlertSent) alreadyAlertSent = true;
    });

    res.render('attendance', { 
      batch, 
      class_number, 
      students, 
      attendanceMap, 
      savedDate, 
      isWhatsAppReady,
      alreadyAlertSent,
      msgSentStatus
    });
  } catch (error) {
    res.status(500).send('Error loading attendance page: ' + error.message);
  }
});

// ১০. হাজিরা সংরক্ষণ ও ব্যাকগ্রাউন্ড মেসেজ প্রেরন (র‍্যাম ক্র্যাশ ও টাইমআউট মুক্ত)
app.post('/attendance/save', isAuthenticated, async (req, res) => {
  try {
    const { batch_id, class_number, class_date, attendance, send_whatsapp } = req.body;
    const batch = await Batch.findById(batch_id);
    const classNum = Number(class_number);
    const isAlertEnabled = (send_whatsapp === 'on' && isWhatsAppReady);
    
    await Attendance.deleteMany({ batch: batch_id, classNumber: classNum });

    if (attendance && typeof attendance === 'object') {
      const recordsToInsert = Object.keys(attendance).map(studentId => ({
        batch: batch_id,
        student: studentId,
        classNumber: classNum,
        date: class_date,
        status: attendance[studentId],
        isAlertSent: isAlertEnabled
      }));
      await Attendance.insertMany(recordsToInsert);

      // ব্যাকগ্রাউন্ড কিউ
      if (isAlertEnabled) {
        (async () => {
          try {
            const studentIds = Object.keys(attendance);
            const students = await Student.find({ _id: { $in: studentIds } });
            const allPastRecords = await Attendance.find({ 
              batch: batch_id,
              classNumber: { $lt: classNum }
            }).sort({ classNumber: -1 });

            for (let student of students) {
              const waId = formatToWhatsAppId(student.phone);
              if (!waId) continue;

              const status = attendance[student._id.toString()];
              let msg = '';

              if (status === 'Absent') {
                let consecutiveAbsentCount = 1;
                for (let c = classNum - 1; c >= 1; c--) {
                  const prevRec = allPastRecords.find(
                    r => r.student.toString() === student._id.toString() && r.classNumber === c
                  );
                  if (prevRec && prevRec.status === 'Absent') {
                    consecutiveAbsentCount++;
                  } else {
                    break;
                  }
                }

                if (consecutiveAbsentCount >= 2) {
                  msg = `আসসালামু আলাইকুম।\nসম্মানিত অভিভাবক, আপনার সন্তান *${student.name}* UKA Technical Institute-এর "${batch.name}" কোর্সে গত *${consecutiveAbsentCount} টি ক্লাসে ধারাবাহিকভাবে অনুপস্থিত* রয়েছে। অনুগ্রহ করে দ্রুত ইনস্টিটিউটে *ছুটির আবেদনপত্র (Leave Application)* জমা দিন, অন্যথায় প্রতিষ্ঠানের নিয়ম অনুযায়ী জরিমানা ধার্য করা হতে পারে। শিক্ষার্থীদের নিয়মিত উপস্থিতি ও অগ্রগতিতে আপনাদের আন্তরিক সহযোগিতা কাম্য।\n\n- UKA Technical Institute প্রশাসন`;
                } else {
                  msg = `আসসালামু আলাইকুম।\nসম্মানিত অভিভাবক, আপনার সন্তান *${student.name}* অদ্য (${class_date}) তারিখে *UKA Technical Institute*-এর "${batch.name}"-এর ${classNum}-তম ক্লাসে অনুপস্থিত ছিল। আশা করি পরবর্তী ক্লাসে সে সময়মতো ক্লাসে উপস্থিত থাকবে। ধন্যবাদ।\n\n- UKA Technical Institute প্রশাসন`;
                }
              } else if (status === 'Present') {
                msg = `আসসালামু আলাইকুম।\nসম্মানিত অভিভাবক, আপনার সন্তান *${student.name}* অদ্য (${class_date}) তারিখে *UKA Technical Institute*-এর "${batch.name}"-এর ${classNum}-তম ক্লাসে উপস্থিত ছিল। ধন্যবাদ।\n\n- UKA Technical Institute প্রশাসন`;
              }

              if (msg && waClient) {
                await waClient.sendMessage(waId, msg).catch(e => console.error(`Error sending to ${student.name}:`, e.message));
                await new Promise(r => setTimeout(r, 1200)); // প্রতি মেসেজে ১.২ সেকেন্ড গ্যাপ
              }
            }
          } catch (bgError) {
            console.error('Background message error:', bgError);
          }
        })();
      }
    }
    
    res.redirect(`/attendance/${batch_id}/${class_number}?msg_sent=${isAlertEnabled}`);
  } catch (error) {
    res.status(500).send('Error saving attendance: ' + error.message);
  }
});

// ১১. ডেইলি ক্লাস রিপোর্ট
app.get('/report/daily/:batch_id/:class_number', isAuthenticated, async (req, res) => {
  try {
    const { batch_id, class_number } = req.params;
    const batch = await Batch.findById(batch_id);
    if (!batch) return res.redirect('/');

    const students = await Student.find({ batch: batch_id }).sort({ createdAt: 1 });
    const records = await Attendance.find({ batch: batch_id, classNumber: Number(class_number) });

    const attendanceMap = {};
    let classDate = '';
    let presentCount = 0;
    let absentCount = 0;

    records.forEach(r => {
      attendanceMap[r.student.toString()] = r.status;
      classDate = r.date;
      if (r.status === 'Present') presentCount++;
      if (r.status === 'Absent') absentCount++;
    });

    res.render('report_daily', {
      batch,
      class_number,
      students,
      attendanceMap,
      classDate,
      presentCount,
      absentCount
    });
  } catch (error) {
    res.status(500).send('Error generating daily report: ' + error.message);
  }
});

// ১২. ফুল কোর্স রিপোর্ট
app.get('/report/full/:batch_id', isAuthenticated, async (req, res) => {
  try {
    const batch = await Batch.findById(req.params.batch_id);
    if (!batch) return res.redirect('/');

    const students = await Student.find({ batch: req.params.batch_id }).sort({ createdAt: 1 });
    const allAttendances = await Attendance.find({ batch: req.params.batch_id });

    const completedClasses = [...new Set(allAttendances.map(a => a.classNumber))].sort((a, b) => a - b);
    const completedClassesCount = completedClasses.length;

    const studentReports = students.map(s => {
      const studentRecords = allAttendances.filter(a => a.student.toString() === s._id.toString());
      const present = studentRecords.filter(a => a.status === 'Present').length;
      const absent = studentRecords.filter(a => a.status === 'Absent').length;
      const percentage = completedClassesCount > 0 ? Math.round((present / completedClassesCount) * 100) : 0;

      let badgeClass = 'bg-success text-white';
      if (percentage < 75) badgeClass = 'bg-warning text-dark';
      if (percentage < 50) badgeClass = 'bg-danger text-white';

      return {
        _id: s._id,
        name: s.name,
        phone: s.phone,
        present,
        absent,
        percentage,
        badgeClass
      };
    });

    res.render('report_full', {
      batch,
      students: studentReports,
      completedClassesCount,
      remainingClassesCount: Math.max(0, (batch.totalClasses || 0) - completedClassesCount)
    });
  } catch (error) {
    res.status(500).send('Error generating full report: ' + error.message);
  }
});

// হেলথ চেক রাউট (UptimeRobot বা বাহ্যিক পিংয়ের জন্য)
app.get('/ping', (req, res) => {
  res.status(200).send('Pong! Server is awake.');
});

// সেল্ফ-পিং সার্ভিস
const SERVER_URL = process.env.RENDER_EXTERNAL_URL;
if (SERVER_URL) {
  setInterval(() => {
    fetch(`${SERVER_URL}/ping`)
      .then(() => console.log('⏰ Keep-Alive self-ping sent successfully'))
      .catch(err => console.error('Keep-Alive ping error:', err.message));
  }, 10 * 60 * 1000);
}

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running at http://localhost:${PORT}`));
require('dotenv').config();
const express = require('express');
const session = require('express-session');
const mongoose = require('mongoose');
const path = require('path');
const https = require('https');
const QRCode = require('qrcode');
const pino = require('pino');
const {
  default: makeWASocket,
  DisconnectReason,
  initAuthCreds,
  BufferJSON,
  proto,
  fetchLatestBaileysVersion
} = require('@whiskeysockets/baileys');

const Batch = require('./models/Batch');
const Student = require('./models/Student');
const Attendance = require('./models/Attendance');

const app = express();

// ================= MongoDB Connection =================
const mongoURI = process.env.MONGODB_URI;

// ================= WhatsApp (Baileys) State =================
let sock = null;
let isWhatsAppReady = false;
let currentQRCodeDataUrl = null;
let waReadyAt = 0;
const WA_WARMUP_MS = 3000;
let waSendQueueBusy = false;
const waSendQueue = [];
let waStarting = false;

// MongoDB-তে সেশন ডাটা সংরক্ষণের স্কিমা
const authSchema = new mongoose.Schema(
  { _id: String, value: String },
  { collection: 'whatsapp_auth', versionKey: false }
);
const WhatsAppAuth = mongoose.models.WhatsAppAuth || mongoose.model('WhatsAppAuth', authSchema);

async function writeAuthData(id, data) {
  const value = JSON.stringify(data, BufferJSON.replacer);
  await WhatsAppAuth.updateOne({ _id: id }, { $set: { value } }, { upsert: true });
}

async function readAuthData(id) {
  const doc = await WhatsAppAuth.findOne({ _id: id }).lean();
  if (!doc) return null;
  return JSON.parse(doc.value, BufferJSON.reviver);
}

async function removeAuthData(id) {
  await WhatsAppAuth.deleteOne({ _id: id });
}

async function clearAllAuthData() {
  await WhatsAppAuth.deleteMany({});
}

// Baileys MongoDB Auth State
async function useMongoAuthState() {
  const creds = (await readAuthData('creds')) || initAuthCreds();

  return {
    state: {
      creds,
      keys: {
        get: async (type, ids) => {
          const data = {};
          await Promise.all(
            ids.map(async (id) => {
              let value = await readAuthData(`${type}-${id}`);
              if (type === 'app-state-sync-key' && value) {
                value = proto.Message.AppStateSyncKeyData.fromObject(value);
              }
              data[id] = value;
            })
          );
          return data;
        },
        set: async (data) => {
          const tasks = [];
          for (const category in data) {
            for (const id in data[category]) {
              const value = data[category][id];
              const key = `${category}-${id}`;
              tasks.push(value ? writeAuthData(key, value) : removeAuthData(key));
            }
          }
          await Promise.all(tasks);
        }
      }
    },
    saveCreds: () => writeAuthData('creds', creds)
  };
}

async function startWhatsApp() {
  if (waStarting) return;
  waStarting = true;
  try {
    const { state, saveCreds } = await useMongoAuthState();
    const { version } = await fetchLatestBaileysVersion();

    sock = makeWASocket({
      version,
      auth: state,
      logger: pino({ level: 'silent' }),
      browser: ['UKA Attendance System', 'Chrome', '1.0.0'],
      syncFullHistory: false,
      markOnlineOnConnect: false,
      generateHighQualityLinkPreview: false
    });

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', async (update) => {
      const { connection, lastDisconnect, qr } = update;

      if (qr) {
        try {
          currentQRCodeDataUrl = await QRCode.toDataURL(qr, { margin: 2, width: 280 });
          isWhatsAppReady = false;
          waReadyAt = 0;
          console.log('📱 New WhatsApp QR Code generated for web portal.');
        } catch (err) {
          console.error('QR generation error:', err);
        }
      }

      if (connection === 'open') {
        isWhatsAppReady = true;
        waReadyAt = Date.now();
        currentQRCodeDataUrl = null;
        console.log('\n✅ WhatsApp Connected & Ready to send Attendance Alerts!\n');
      }

      if (connection === 'close') {
        isWhatsAppReady = false;
        waReadyAt = 0;
        const statusCode = lastDisconnect?.error?.output?.statusCode;
        const loggedOut = statusCode === DisconnectReason.loggedOut;
        console.log('⚠️ WhatsApp Disconnected. StatusCode:', statusCode, 'LoggedOut:', loggedOut);

        waStarting = false;

        if (loggedOut) {
          console.log('🔒 Session logged out — clearing saved session, new QR will be needed.');
          await clearAllAuthData().catch(e => console.error('Clear auth error:', e.message));
          setTimeout(() => startWhatsApp().catch(err => console.error('Re-init error:', err)), 3000);
        } else {
          setTimeout(() => startWhatsApp().catch(err => console.error('Re-init error:', err)), 5000);
        }
      }
    });
  } catch (err) {
    waStarting = false;
    console.error('WhatsApp start error:', err.message);
    setTimeout(() => startWhatsApp().catch(e => console.error('Re-init error:', e)), 8000);
  }
}

function isWaFullyWarmedUp() {
  return isWhatsAppReady && waReadyAt > 0 && (Date.now() - waReadyAt) >= WA_WARMUP_MS;
}

// BD ফোন নম্বরকে Baileys JID (@s.whatsapp.net) ফরম্যাটে রূপান্তর
function formatToWhatsAppId(phone) {
  if (!phone) return null;
  let cleaned = phone.toString().replace(/[^0-9]/g, '').trim();
  if (cleaned.startsWith('880')) {
    // Already in 880 format
  } else if (cleaned.startsWith('01')) {
    cleaned = '88' + cleaned;
  } else if (cleaned.startsWith('1')) {
    cleaned = '880' + cleaned;
  }
  return cleaned + '@s.whatsapp.net';
}

// বার্তা প্রেরণের ফাংশন
async function sendWhatsAppAlert(waId, message, studentName) {
  let waited = 0;
  while (!isWaFullyWarmedUp() && waited < 30000) {
    if (!sock) return false;
    console.warn(`⏳ WhatsApp not fully ready yet, waiting before sending to ${studentName}...`);
    await new Promise(r => setTimeout(r, 3000));
    waited += 3000;
  }

  if (!isWhatsAppReady || !sock) {
    console.error(`❌ [Skipped] WhatsApp not connected — could not send to ${studentName}`);
    return false;
  }

  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      await sock.sendMessage(waId, { text: message });
      console.log(`✅ [Delivered] Message successfully sent to ${studentName} (${waId})`);
      return true;
    } catch (err) {
      console.warn(`⚠️ [Attempt ${attempt} Failed] for ${studentName}: ${err.message}`);
      if (attempt < 3) {
        await new Promise(r => setTimeout(r, 3000));
      } else {
        console.error(`❌ [Final Failure] Unable to send message to ${studentName}: ${err.message}`);
        return false;
      }
    }
  }
  return false;
}

// কিউ প্রসেসিং
function enqueueWaJob(jobFn) {
  waSendQueue.push(jobFn);
  processWaQueue();
}

async function processWaQueue() {
  if (waSendQueueBusy) return;
  waSendQueueBusy = true;
  while (waSendQueue.length > 0) {
    const job = waSendQueue.shift();
    try {
      await job();
    } catch (e) {
      console.error('WA queue job error:', e.message);
    }
  }
  waSendQueueBusy = false;
}
// ==============================================================

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use(express.static(__dirname));

// সেশন মিডলওয়্যার (ক্র্যাশমুক্ত সুরক্ষিত কনফিগারেশন)
let sessionConfig = {
  secret: process.env.SESSION_SECRET || 'uka_secure_attendance_session_secret_2026',
  resave: false,
  saveUninitialized: false,
  cookie: { maxAge: 1000 * 60 * 60 * 24 * 7 }
};

try {
  const connectMongo = require('connect-mongo');
  const MongoSessionStore = connectMongo.default || connectMongo;
  if (typeof MongoSessionStore.create === 'function') {
    sessionConfig.store = MongoSessionStore.create({
      mongoUrl: process.env.MONGODB_URI,
      collectionName: 'sessions',
      ttl: 7 * 24 * 60 * 60
    });
  }
} catch (e) {
  console.warn('MongoStore notice:', e.message);
}

app.use(session(sessionConfig));

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

// WhatsApp Status API
app.get('/whatsapp/status', isAuthenticated, (req, res) => {
  res.json({
    connected: isWhatsAppReady,
    warmedUp: isWaFullyWarmedUp(),
    qrCode: currentQRCodeDataUrl
  });
});

// WhatsApp Logout
app.post('/whatsapp/logout', isAuthenticated, async (req, res) => {
  try {
    if (sock) {
      try {
        await sock.logout();
      } catch (e) {
        console.warn('Logout notice:', e.message);
      }
    }
    isWhatsAppReady = false;
    waReadyAt = 0;
    currentQRCodeDataUrl = null;
    res.redirect('/');
  } catch (err) {
    console.error('Logout error:', err.message);
    res.redirect('/');
  }
});

// WhatsApp Reset Session
app.post('/whatsapp/reset-cache', isAuthenticated, async (req, res) => {
  try {
    console.log('🔄 Clearing WhatsApp Session via Web Panel...');
    if (sock) {
      try {
        await sock.logout();
      } catch (e) {
        console.warn('Logout during reset notice:', e.message);
      }
      try {
        sock.end(undefined);
      } catch (e) {
        console.warn('Socket end notice:', e.message);
      }
    }

    isWhatsAppReady = false;
    waReadyAt = 0;
    currentQRCodeDataUrl = null;
    waStarting = false;

    await clearAllAuthData();
    await startWhatsApp();
    console.log('✅ WhatsApp session cleared and re-initialized!');
    res.redirect('/');
  } catch (err) {
    console.error('Failed to reset session:', err);
    res.status(500).send('Session reset failed: ' + err.message);
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

// ১০. হাজিরা সংরক্ষণ ও Baileys দিয়ে মেসেজ প্রেরণ
app.post('/attendance/save', isAuthenticated, async (req, res) => {
  try {
    const { batch_id, class_number, class_date, attendance, send_whatsapp } = req.body;
    const batch = await Batch.findById(batch_id);
    const classNum = Number(class_number);

    const shouldSend = (send_whatsapp === 'on' || send_whatsapp === 'true' || send_whatsapp === true);

    await Attendance.deleteMany({ batch: batch_id, classNumber: classNum });

    if (attendance && typeof attendance === 'object') {
      const recordsToInsert = Object.keys(attendance).map(studentId => ({
        batch: batch_id,
        student: studentId,
        classNumber: classNum,
        date: class_date,
        status: attendance[studentId],
        isAlertSent: shouldSend
      }));
      await Attendance.insertMany(recordsToInsert);

      console.log(`\n📌 [Save Request] Batch: ${batch.name}, Class: ${classNum}, Send WhatsApp: ${shouldSend}`);

      if (shouldSend) {
        enqueueWaJob(async () => {
          try {
            const studentIds = Object.keys(attendance);
            const students = await Student.find({ _id: { $in: studentIds } });
            const allPastRecords = await Attendance.find({
              batch: batch_id,
              classNumber: { $lt: classNum }
            }).sort({ classNumber: -1 });

            for (let student of students) {
              const waId = formatToWhatsAppId(student.phone);
              if (!waId) {
                console.warn(`⚠️ Invalid phone number for: ${student.name} (${student.phone})`);
                continue;
              }

              const status = attendance[student._id.toString()];
              let msg = '';
              const cleanName = (student.name || '').trim();

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
                  msg = `আসসালামু আলাইকুম।\nসম্মানিত অভিভাবক, আপনার সন্তান *${cleanName}* UKA Technical Institute-এর "${batch.name}" কোর্সে গত *${consecutiveAbsentCount} টি ক্লাসে ধারাবাহিকভাবে অনুপস্থিত* রয়েছে। অনুগ্রহ করে দ্রুত ইনস্টিটিউটে *ছুটির আবেদনপত্র (Leave Application)* জমা দিন, অন্যথায় প্রতিষ্ঠানের নিয়ম অনুযায়ী জরিমানা ধার্য করা হতে পারে। শিক্ষার্থীদের নিয়মিত উপস্থিতি ও অগ্রগতিতে আপনাদের আন্তরিক সহযোগিতা কাম্য।\n\n- UKA Technical Institute প্রশাসন`;
                } else {
                  msg = `আসসালামু আলাইকুম।\nসম্মানিত অভিভাবক, আপনার সন্তান *${cleanName}* অদ্য (${class_date}) তারিখে *UKA Technical Institute*-এর "${batch.name}"-এর ${classNum}-তম ক্লাসে অনুপস্থিত ছিল। আশা করি পরবর্তী ক্লাসে সে সময়মতো ক্লাসে উপস্থিত থাকবে। ধন্যবাদ।\n\n- UKA Technical Institute প্রশাসন`;
                }
              } else if (status === 'Present') {
                msg = `আসসালামু আলাইকুম।\nসম্মানিত অভিভাবক, আপনার সন্তান *${cleanName}* অদ্য (${class_date}) তারিখে *UKA Technical Institute*-এর "${batch.name}"-এর ${classNum}-তম ক্লাসে উপস্থিত ছিল। ধন্যবাদ।\n\n- UKA Technical Institute প্রশাসন`;
              }

              if (msg) {
                console.log(`📨 Initiating WhatsApp send to ${cleanName} (${waId})...`);
                await sendWhatsAppAlert(waId, msg, cleanName);
                await new Promise(r => setTimeout(r, 1500));
              }
            }
          } catch (bgError) {
            console.error('Background message delivery error:', bgError);
          }
        });
      }
    }

    res.redirect(`/attendance/${batch_id}/${class_number}?msg_sent=${shouldSend}`);
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

// হেলথ চেক রাউট
app.all('/ping', (req, res) => {
  res.status(200).send('Pong! Server is awake.');
});

// সেল্ফ-পিং সার্ভিস
const PING_INTERVAL = 3.5 * 60 * 1000;
const TARGET_URL = 'https://uka-attendance-system.onrender.com/ping';

function sendSelfPing() {
  const req = https.get(TARGET_URL, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
      'Accept': '*/*'
    },
    timeout: 10000
  }, (res) => {
    res.on('data', () => {});
    res.on('end', () => {
      console.log(`⏰ [Keep-Alive] Ping success! Status: ${res.statusCode} at ${new Date().toLocaleTimeString('en-US', { timeZone: 'Asia/Dhaka' })}`);
    });
  });

  req.on('timeout', () => {
    req.destroy();
    console.warn('⏰ [Keep-Alive] Ping timed out, socket reset.');
  });

  req.on('error', (err) => {
    console.error('⏰ [Keep-Alive] Ping request error:', err.message);
  });
}

setTimeout(() => {
  sendSelfPing();
  setInterval(sendSelfPing, PING_INTERVAL);
}, 10 * 1000);

// ================= স্টার্টআপ লজিক =================
const PORT = process.env.PORT || 3000;

mongoose.connect(mongoURI)
  .then(() => {
    console.log('MongoDB Atlas Connected Successfully!');
    startWhatsApp().catch(err => console.error('WhatsApp init error:', err));
    app.listen(PORT, () => console.log(`Server running at http://localhost:${PORT}`));
  })
  .catch(err => {
    console.error('MongoDB Connection Error:', err);
    app.listen(PORT, () => console.log(`Server running at http://localhost:${PORT} (DEGRADED: no MongoDB)`));
  });
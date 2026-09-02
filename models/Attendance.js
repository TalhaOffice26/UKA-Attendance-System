const mongoose = require('mongoose');

const attendanceSchema = new mongoose.Schema({
  batch: { type: mongoose.Schema.Types.ObjectId, ref: 'Batch', required: true },
  student: { type: mongoose.Schema.Types.ObjectId, ref: 'Student', required: true },
  classNumber: { type: Number, required: true },
  date: { type: String, required: true },
  status: { type: String, enum: ['Present', 'Absent'], required: true },
  isAlertSent: { type: Boolean, default: false }
}, { timestamps: true });

module.exports = mongoose.model('Attendance', attendanceSchema);
const mongoose = require('mongoose');

const batchSchema = new mongoose.Schema({
  name: { type: String, required: true },
  category: { 
    type: String, 
    enum: ["Junior Spoken English", "IELTS Batches", "Spoken Phonetics Batches"],
    required: true 
  },
  totalClasses: { type: Number, default: 40 },
  teacherName: { type: String, default: '' },
  teacherPhone: { type: String, default: '' }
}, { timestamps: true });

module.exports = mongoose.model('Batch', batchSchema);
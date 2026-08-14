const mongoose = require('mongoose');

async function connectDb() {
    try {
        await mongoose.connect('mongodb+srv://tiwariraushan60_db_user:A45QBLDjDtJ7Mj6q@cluster0.j51zlhr.mongodb.net/users')
        console.log('MongoDB connected successfully');
    } catch (error) {
        console.log(error);
    }
}

module.exports = connectDb;
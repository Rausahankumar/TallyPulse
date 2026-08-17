const { importTallySales } = require('../services/import/tallySalesImport');

const importTallyJson = async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({
        success: false,
        message: 'No JSON file uploaded. Please send a multipart/form-data file with field name "file".'
      });
    }

    const fileName = req.file.originalname || '';
    const isJsonFile = fileName.toLowerCase().endsWith('.json') || req.file.mimetype === 'application/json';

    if (!isJsonFile) {
      return res.status(400).json({
        success: false,
        message: 'Only JSON files are allowed.'
      });
    }

    const result = await importTallySales({ filePath: req.file.path });

    if (result && Array.isArray(result.results)) {
      return res.status(200).json({
        success: true,
        message: 'Tally sales import summary',
        data: {
          total: result.total,
          created: result.created,
          duplicates: result.duplicates,
          failed: result.failed,
          results: result.results,
        }
      });
    }

    if (result && result.duplicate) {
      return res.status(200).json({
        success: true,
        message: 'Sale already exists',
        data: {
          created: false,
          duplicate: true,
          saleId: result.sale && result.sale._id ? String(result.sale._id) : null,
        }
      });
    }

    return res.status(200).json({
      success: true,
      message: 'Tally sales imported successfully',
      data: {
        created: true,
        duplicate: false,
        saleId: result.sale && result.sale._id ? String(result.sale._id) : null,
      }
    });
  } catch (error) {
    const message = error && error.message ? error.message : 'Unexpected import error';

    if (
      message.includes('Invalid JSON') ||
      message.includes('Parser error') ||
      message.includes('Mapper error') ||
      message.includes('Mongoose validation failed') ||
      message.includes('Only JSON files are allowed') ||
      message.includes('No JSON file uploaded')
    ) {
      return res.status(400).json({
        success: false,
        message
      });
    }

    return res.status(500).json({
      success: false,
      message
    });
  }
};

module.exports = {
  importTallyJson
};

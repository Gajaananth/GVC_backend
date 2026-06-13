const { validateFacePhoto } = require('./dist/utils/faceDetection');
validateFacePhoto(Buffer.from('')).then(console.log).catch(console.error);

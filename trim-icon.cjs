const sharp = require('sharp');
const fs = require('fs');

async function processIcon() {
  const inputPath = 'Kaptur-icons/icons/icon.png';
  const outputPath = 'Kaptur-icons/icons/icon_cropped.png';

  try {
    console.log('Trimming transparent pixels...');
    // trim() removes transparent borders. 
    // Then we resize to 512x512 with a small padding (e.g., 5-10%) so it looks perfect as an icon.
    await sharp(inputPath)
      .trim()
      .resize({
        width: 512,
        height: 512,
        fit: 'contain',
        background: { r: 0, g: 0, b: 0, alpha: 0 } // transparent
      })
      .toFile(outputPath);
      
    // Replace original
    fs.copyFileSync(outputPath, inputPath);
    console.log('Done!');
  } catch (err) {
    console.error('Error processing icon:', err);
  }
}

processIcon();

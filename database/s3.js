// aws-s3.js - Memory Storage Version
const { S3Client, GetObjectCommand, ListObjectsV2Command, DeleteObjectCommand, CopyObjectCommand, PutObjectCommand } = require("@aws-sdk/client-s3");
const crypto = require("crypto");
const { Upload } = require("@aws-sdk/lib-storage");
const { getSignedUrl } = require("@aws-sdk/s3-request-presigner");
const multer = require('multer');
const sharp = require('sharp');
const path = require('path');
require('dotenv').config();
const EXT_BY_MIME = {
  "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp", "image/gif": "gif",
  "video/mp4": "mp4", "video/webm": "webm", "video/quicktime": "mov",
};

const UPLOAD_CACHE_CONTROL = "public, max-age=31536000, immutable";

// Returns a short-lived URL the browser can PUT a file to directly.
const createPresignedUpload = async ({ prefix, contentType }) => {
  const ext = EXT_BY_MIME[contentType];
  if (!ext) throw new Error(`Unsupported content type: ${contentType}`);

  const key = `${prefix.replace(/\/$/, "")}/${crypto.randomUUID()}.${ext}`;
  const uploadUrl = await getSignedUrl(
    s3Client,
    new PutObjectCommand({
      Bucket: process.env.S3_BUCKET_NAME,
      Key: key,
      ContentType: contentType,
      CacheControl: UPLOAD_CACHE_CONTROL,
    }),
    { expiresIn: 600 }
  );

  return {
    uploadUrl,
    publicUrl: getCdnUrl(key), // CloudFront URL, same format your old uploads returned
    contentType,
    cacheControl: UPLOAD_CACHE_CONTROL,
  };
};

// Create S3 client
const s3Client = new S3Client({
  region: process.env.AWS_REGION,
  credentials: {
    accessKeyId: process.env.AWS_ACCESS_KEY_ID,
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
  },
});

const MAX_IMAGE_DIMENSION = 3000; // longest side, px

const prepareImage = (buffer) =>
  sharp(buffer)
    .rotate()
    .resize({
      width: MAX_IMAGE_DIMENSION,
      height: MAX_IMAGE_DIMENSION,
      fit: 'inside',
      withoutEnlargement: true,
    });

// Helper to construct CloudFront CDN URL (with S3 fallback)
const getCdnUrl = (key) => {
  const cdnBase = process.env.CLOUDFRONT_DOMAIN;
  if (cdnBase) {
    // Remove trailing slash if present and append the key
    return `${cdnBase.replace(/\/$/, '')}/${key.replace(/^\//, '')}`;
  }
  return `https://${process.env.S3_BUCKET_NAME}.s3.${process.env.AWS_REGION || 'ap-southeast-1'}.amazonaws.com/${key}`;
};

// Create multer instance with memory storage
const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 50 * 1024 * 1024, // 50MB limit
    files: 11 // Maximum 11 files total
  }
});

// Image conversion functions
const convertToWebP = async (buffer, quality = 100) => {
  try {
    return await prepareImage(buffer).webp({ quality }).toBuffer();
  } catch (error) {
    console.error("Error converting to WebP:", error);
    throw error;
  }
};

const convertToAVIF = async (buffer, quality = 70) => {
  try {
    return await prepareImage(buffer).avif({ quality }).toBuffer();
  } catch (error) {
    console.error("Error converting to AVIF:", error);
    throw error;
  }
};
// Move file in S3
const moveFileInS3 = async (sourceKey, destinationKey) => {
  const copyParams = {
    Bucket: process.env.S3_BUCKET_NAME,
    CopySource: `${process.env.S3_BUCKET_NAME}/${sourceKey}`,
    Key: destinationKey
  };

  try {
    // First copy the file to the new location
    await s3Client.send(new CopyObjectCommand(copyParams));

    // Then delete the original file
    const deleteParams = {
      Bucket: process.env.S3_BUCKET_NAME,
      Key: sourceKey
    };
    await s3Client.send(new DeleteObjectCommand(deleteParams));

    // Return the CloudFront URL
    return getCdnUrl(destinationKey);
  } catch (error) {
    console.error("Error moving file in S3:", error);
    throw error;
  }
};

const uploadMediaFileToS3 = async (file, fileName, options = {}) => {
  try {
    let fileBuffer = file.buffer;
    let contentType = file.mimetype;
    let finalFileName = fileName;

    // Default options
    const defaultOptions = {
      maxSizeInMB: 100, // 100MB default max size
      allowedTypes: [
        'video/mp4', 'video/webm', 'video/quicktime', 'video/x-msvideo',
        'image/jpeg', 'image/png', 'image/gif', 'image/webp', 'image/avif'
      ],
      convertImages: true, // Whether to convert images to AVIF/WebP
      imageFormat: 'avif', // Default image format if converting
      folder: '', // Optional subfolder
      skipTypeValidation: false // Skip file type validation if needed
    };

    // Merge provided options with defaults
    const config = { ...defaultOptions, ...options };

    // Validate file type if not skipped
    if (!config.skipTypeValidation && !config.allowedTypes.includes(contentType)) {
      throw new Error(`File type ${contentType} not allowed. Allowed types: ${config.allowedTypes.join(', ')}`);
    }

    // Validate file size (convert MB to bytes)
    const fileSizeInMB = fileBuffer.length / (1024 * 1024);
    if (fileSizeInMB > config.maxSizeInMB) {
      throw new Error(`File size exceeds the limit of ${config.maxSizeInMB}MB`);
    }

    // Handle images - convert them if option is set
    if (contentType.startsWith('image/') && config.convertImages) {
      if (config.imageFormat === 'avif' && contentType !== 'image/avif') {
        fileBuffer = await convertToAVIF(fileBuffer);
        contentType = 'image/avif';
        finalFileName = finalFileName.replace(/\.[^/.]+$/, '') + '.avif';
      } else if (config.imageFormat === 'webp' && contentType !== 'image/webp') {
        fileBuffer = await convertToWebP(fileBuffer);
        contentType = 'image/webp';
        finalFileName = finalFileName.replace(/\.[^/.]+$/, '') + '.webp';
      }
    }

    // Add folder prefix if specified
    if (config.folder) {
      const normalizedFolder = config.folder.endsWith('/')
        ? config.folder
        : `${config.folder}/`;
      finalFileName = `${normalizedFolder}${finalFileName}`;
    }

    const params = {
      Bucket: process.env.S3_BUCKET_NAME,
      Key: finalFileName,
      Body: fileBuffer,
      ContentType: contentType,
      CacheControl: "public, max-age=31536000, immutable" // Enables 1-year edge & browser caching
    };

    const upload = new Upload({
      client: s3Client,
      params: params,
    });

    await upload.done();
    return {
      url: getCdnUrl(finalFileName), // Return CloudFront domain
      key: finalFileName,
      size: fileBuffer.length,
      contentType
    };
  } catch (error) {
    console.error("Error uploading media file to S3:", error);
    throw error;
  }
};

// Upload multiple files to S3 - memory version
const uploadMediaFilesToS3 = async (files, userId = 0, type, options = {}) => {
  try {
    if (!files) {
      return [];
    }
    const fileArray = Array.isArray(files) ? files : [files];
    if (fileArray.length === 0) {
      return [];
    }

    // Default options for path configuration
    const defaultOptions = {
      pathPrefix: 'products', // Default to 'products', can be changed to 'vintage_products'
      skipTypeValidation: false,
      convertImages: true,
      imageFormat: 'avif'
    };

    const config = { ...defaultOptions, ...options };

    // Create an array of promises for parallel execution
    const uploadPromises = fileArray.map(async (file) => {
      if (!file || !file.originalname) {
        console.warn('Skipping invalid file:', file);
        return null;
      }

      const timestamp = Date.now();
      const randomString = Math.random().toString(36).substring(2, 8);
      const extension = file.originalname ? path.extname(file.originalname) : '';
      const s3FileName = `${timestamp}-${randomString}${extension}`;

      try {
        const result = await uploadMediaFileToS3(file, s3FileName, {
          folder: `${config.pathPrefix}/${userId}/${type}s`,
          skipTypeValidation: config.skipTypeValidation,
          convertImages: config.convertImages && type === 'image',
          imageFormat: config.imageFormat
        });

        return result.url; // Returns CloudFront URL from uploadMediaFileToS3
      } catch (error) {
        console.error(`Error uploading file ${file.originalname}:`, error);
        return null;
      }
    });

    const results = await Promise.all(uploadPromises);
    return results.filter(url => url !== null);
  } catch (error) {
    console.error(`Error uploading ${type} files to S3:`, error);
    throw error;
  }
};

const uploadSingleFileToS3 = async (file, userId, type, index = 0) => {
  try {
    if (global.gc) {
      global.gc();
    }

    const timestamp = Date.now();
    const randomString = Math.random().toString(36).substring(2, 8);
    const extension = path.extname(file.originalname) || '';
    const s3FileName = `products/${userId}/${type}s/${timestamp}-${randomString}${extension}`;

    const params = {
      Bucket: process.env.S3_BUCKET_NAME,
      Key: s3FileName,
      Body: file.buffer,
      ContentType: file.mimetype,
      CacheControl: "public, max-age=31536000, immutable" // Enables 1-year edge & browser caching
    };

    const upload = new Upload({
      client: s3Client,
      params: params,
    });

    await upload.done();

    // Clear the file buffer from memory immediately
    file.buffer = null;

    return getCdnUrl(s3FileName); // Return CloudFront domain

  } catch (error) {
    console.error(`Error uploading file ${index + 1}:`, error);
    throw error;
  }
};

const uploadFilesSequentially = async (files, userId, type) => {
  if (!files || files.length === 0) return [];

  const uploadedUrls = [];

  for (let i = 0; i < files.length; i++) {
    try {
      console.log(`Processing ${type} ${i + 1}/${files.length} (${files[i].originalname})`);

      const url = await uploadSingleFileToS3(files[i], userId, type, i);
      uploadedUrls.push(url);

      // Add delay between uploads to prevent overwhelming the server
      await new Promise(resolve => setTimeout(resolve, 500));

      if (global.gc) {
        global.gc();
      }

    } catch (error) {
      console.error(`Failed to upload ${type} ${i + 1}:`, error);
    }
  }

  return uploadedUrls;
};

// File operations
const uploadFileToS3 = async (file, fileName, format = 'avif') => {
  try {
    let fileBuffer = file.buffer;
    let contentType = file.mimetype;
    let finalFileName = fileName;

    // Check if file is an image
    if (file.mimetype.startsWith('image/')) {
      if (format === 'avif') {
        if (file.mimetype === 'image/avif') {
          console.log('Image is already in AVIF format. Skipping conversion.');
          fileBuffer = file.buffer;
          contentType = 'image/avif';
          finalFileName = fileName.replace(/\.[^/.]+$/, '') + '.avif';
        } else {
          fileBuffer = await convertToAVIF(file.buffer);
          contentType = 'image/avif';
          finalFileName = fileName.replace(/\.[^/.]+$/, '') + '.avif';
        }
      }
    }

    const params = {
      Bucket: process.env.S3_BUCKET_NAME,
      Key: finalFileName,
      Body: fileBuffer,
      ContentType: contentType,
      CacheControl: "public, max-age=31536000, immutable" // Enables 1-year edge & browser caching
    };

    const upload = new Upload({
      client: s3Client,
      params: params,
    });

    await upload.done();
    return getCdnUrl(finalFileName); // Return CloudFront domain
  } catch (error) {
    console.error("Error uploading file to S3:", error);
    throw error;
  }
};

// Delete file from S3 (supports both CloudFront and S3 URLs)
const deleteFileFromS3 = async (fileUrl) => {
  try {
    let key;
    if (fileUrl.includes('.amazonaws.com/')) {
      key = fileUrl.split('.amazonaws.com/')[1];
    } else {
      // Handles CloudFront domain URL: extracts the path key after the host
      const urlObj = new URL(fileUrl);
      key = urlObj.pathname.substring(1);
    }

    const params = {
      Bucket: process.env.S3_BUCKET_NAME,
      Key: key,
    };

    await s3Client.send(new DeleteObjectCommand(params));
    return true;
  } catch (error) {
    console.error("Error deleting file from S3:", error);
    throw error;
  }
};

// Get a signed URL for a file in S3
const getFileUrlFromS3 = async (fileName) => {
  const params = {
    Bucket: process.env.S3_BUCKET_NAME,
    Key: fileName
  };

  try {
    const command = new GetObjectCommand(params);
    const signedUrl = await getSignedUrl(s3Client, command, {expiresIn: 3600});
    return signedUrl;
  } catch (error) {
    console.error("Error getting file URL from S3:", error);
    throw error;
  }
};

// Test S3 connection
const testS3Connection = async () => {
  try {
    const testFileName = 'test-connection.txt';
    const params = {
      Bucket: process.env.S3_BUCKET_NAME,
      Key: testFileName,
      Body: 'This is a test file to verify S3 connection',
      ContentType: 'text/plain'
    };

    const upload = new Upload({
      client: s3Client,
      params: params,
    });

    await upload.done();

    await s3Client.send(new DeleteObjectCommand({
      Bucket: process.env.S3_BUCKET_NAME,
      Key: testFileName
    }));

    console.log('Successfully connected to S3');
    return true;
  } catch (error) {
    console.error('Failed to connect to S3 bucket:', error);
    return false;
  }
};

module.exports = {
  upload,
  s3Client,
  getCdnUrl,
  uploadMediaFileToS3,
  uploadMediaFilesToS3,
  uploadFileToS3,
  deleteFileFromS3,
  getFileUrlFromS3,
  testS3Connection,
  moveFileInS3,
  convertToWebP,
  convertToAVIF,
  uploadFilesSequentially,
  uploadSingleFileToS3,
  createPresignedUpload,
  getCdnUrl,
  EXT_BY_MIME
};
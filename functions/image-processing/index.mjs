// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

import {PutObjectCommand, S3Client} from "@aws-sdk/client-s3";
import Sharp from 'sharp';

const s3Client = new S3Client();
const S3_ORIGINAL_IMAGE_BUCKET = process.env.originalImageBucketName;
const S3_TRANSFORMED_IMAGE_BUCKET = process.env.transformedImageBucketName;
const TRANSFORMED_IMAGE_CACHE_TTL = process.env.transformedImageCacheTTL;
const MAX_IMAGE_SIZE = parseInt(process.env.maxImageSize);

export const handler = async (event) => {
    // Validate if this is a GET request
    if (!event.requestContext || !event.requestContext.http || !(event.requestContext.http.method === 'GET')) return sendError(400, 'Only GET method is supported', event);
    // An example of expected path is /images/rio/1.jpeg/format=auto,width=100 or /images/rio/1.jpeg/original where /images/rio/1.jpeg is the path of the original image
    var imagePathArray = event.requestContext.http.path.split('/');
    // get the requested image operations
    var operationsPrefix = imagePathArray.pop();
    // get the original image path images/rio/1.jpg
    imagePathArray.shift();
    var originalImagePath = imagePathArray.join('/');

    var startTime = performance.now();
    // Downloading original image
    let originalImageBody;
    let contentType = '';
    try {
        // const getOriginalImageCommand = new GetObjectCommand({ Bucket: S3_ORIGINAL_IMAGE_BUCKET, Key: originalImagePath });
        // const getOriginalImageCommandOutput = await s3Client.send(getOriginalImageCommand);
        // console.log(`Got response from S3 for ${originalImagePath}`);
        // originalImageBody = getOriginalImageCommandOutput.Body.transformToByteArray();

        console.log(event)
        var allowedHeaders = [
            'X-Amz-Algorithm',
            'X-Amz-Credential',
            'X-Amz-Date',
            'X-Amz-Expires',
            'X-Amz-SignedHeaders',
            'x-id',
            'X-Amz-Signature',
        ];
        console.log('headers=', event.headers);
        var regions = {
            "movii0s1": "ap-northeast-1",
            "movii1s1": "us-east-1"
        };
        var region = regions[S3_ORIGINAL_IMAGE_BUCKET] || "ap-northeast-1";
        var url = new URL(`https://${S3_ORIGINAL_IMAGE_BUCKET}.s3.${region}.amazonaws.com/${originalImagePath}`);

        let paramsMap = new Map();
        for (const [key, value] of Object.entries(event.headers)) {
            if (key.toLowerCase() === 'x-amz-date-temp') {
                let date = decodeURIComponent(value)
                paramsMap.set('x-amz-date', date);
                continue
            }
            if (key.toLowerCase() === 'x-amz-date') {
                console.log('skip key=', key)
                continue
            }
            allowedHeaders.forEach(header => {
                if (header.toLowerCase() === key.toLowerCase()) {
                    paramsMap.set(key.toLowerCase(), decodeURIComponent(value));
                }
            });
        }
        console.log('params=', url.searchParams.toString())
        paramsMap.set('x-id', 'GetObject')
        allowedHeaders.forEach(header => {
            if (paramsMap.has(header.toLowerCase())) {
                url.searchParams.set(header, paramsMap.get(header.toLowerCase()));
            }
        });

        console.log('url=', url.toString())
        var response;
        try {
            response = await fetch(url.toString());
            if (response.headers.has('Content-Type')) {
                contentType = response.headers.get('Content-Type');
                console.log(response.headers.get('Content-Type'))
            }
            var blob = await response.blob();
            originalImageBody = Buffer.from(await blob.arrayBuffer());
            console.log(originalImageBody);
        } catch (err) {
            return sendError(500, 'error downloading image', err);
        }

    } catch (error) {
        return sendError(500, 'Error downloading original image', error);
    }
    let transformedImage = Sharp(originalImageBody, {failOn: 'none', animated: true});
    // Get image orientation to rotate if needed
    const imageMetadata = await transformedImage.metadata();
    // execute the requested operations 
    const operationsJSON = Object.fromEntries(operationsPrefix.split(',').map(operation => operation.split('=')));
    // variable holding the server timing header value
    var timingLog = 'img-download;dur=' + parseInt(performance.now() - startTime);
    startTime = performance.now();
    try {
        // check if resizing is requested
        var resizingOptions = {};
        if (operationsJSON['width']) resizingOptions.width = parseInt(operationsJSON['width']);
        if (operationsJSON['height']) resizingOptions.height = parseInt(operationsJSON['height']);
        if (resizingOptions) transformedImage = transformedImage.resize(resizingOptions);
        // check if rotation is needed
        if (imageMetadata.orientation) transformedImage = transformedImage.rotate();
        // check if formatting is requested
        if (operationsJSON['format']) {
            var isLossy = false;
            switch (operationsJSON['format']) {
                case 'jpeg':
                    contentType = 'image/jpeg';
                    isLossy = true;
                    break;
                case 'gif':
                    contentType = 'image/gif';
                    break;
                case 'webp':
                    contentType = 'image/webp';
                    isLossy = true;
                    break;
                case 'png':
                    contentType = 'image/png';
                    break;
                case 'avif':
                    contentType = 'image/avif';
                    isLossy = true;
                    break;
                default:
                    contentType = 'image/jpeg';
                    isLossy = true;
            }
            if (operationsJSON['quality'] && isLossy) {
                transformedImage = transformedImage.toFormat(operationsJSON['format'], {
                    quality: parseInt(operationsJSON['quality']),
                });
            } else transformedImage = transformedImage.toFormat(operationsJSON['format']);
        } else {
            /// If not format is precised, Sharp converts svg to png by default https://github.com/aws-samples/image-optimization/issues/48
            if (contentType === 'image/svg+xml') contentType = 'image/png';
        }
        transformedImage = await transformedImage.toBuffer();
    } catch (error) {
        return sendError(500, 'error transforming image', error);
    }
    timingLog = timingLog + ',img-transform;dur=' + parseInt(performance.now() - startTime);

    // handle gracefully generated images bigger than a specified limit (e.g. Lambda output object limit)
    const imageTooBig = Buffer.byteLength(transformedImage) > MAX_IMAGE_SIZE;

    // upload transformed image back to S3 if required in the architecture
    if (S3_TRANSFORMED_IMAGE_BUCKET) {
        startTime = performance.now();
        try {
            const putImageCommand = new PutObjectCommand({
                Body: transformedImage,
                Bucket: S3_TRANSFORMED_IMAGE_BUCKET,
                Key: originalImagePath + '/' + operationsPrefix,
                ContentType: contentType,
                CacheControl: TRANSFORMED_IMAGE_CACHE_TTL,
            })
            await s3Client.send(putImageCommand);
            timingLog = timingLog + ',img-upload;dur=' + parseInt(performance.now() - startTime);
            // If the generated image file is too big, send a redirection to the generated image on S3, instead of serving it synchronously from Lambda. 
            if (imageTooBig) {
                return {
                    statusCode: 302,
                    headers: {
                        'Location': '/' + originalImagePath + '?' + operationsPrefix.replace(/,/g, "&"),
                        'Cache-Control': 'private,no-store',
                        'Server-Timing': timingLog
                    }
                };
            }
        } catch (error) {
            logError('Could not upload transformed image to S3', error);
        }
    }

    // Return error if the image is too big and a redirection to the generated image was not possible, else return transformed image
    if (imageTooBig) {
        return sendError(403, 'Requested transformed image is too big', '');
    } else return {
        statusCode: 200,
        body: transformedImage.toString('base64'),
        isBase64Encoded: true,
        headers: {
            'Content-Type': contentType,
            'Cache-Control': TRANSFORMED_IMAGE_CACHE_TTL,
            'Server-Timing': timingLog
        }
    };
};

function sendError(statusCode, body, error) {
    logError(body, error);
    return {statusCode, body};
}

function logError(body, error) {
    console.log('APPLICATION ERROR', body);
    console.log(error);
}

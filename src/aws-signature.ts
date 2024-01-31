import { IncomingRequest } from "moleculer-web";
import crypto, { BinaryLike, KeyObject } from 'crypto';
import querystring from 'querystring';

enum Headers {
    'Authorization' = 'authorization',
    'XAmzDate' = 'x-amz-date',
    'XAmzContentSha256' = 'x-amz-content-sha256',
    'XAmzExpires' = 'x-amz-expires',
}

function verifySigV4(req: IncomingRequest) {

    // Get the AWS signature v4 headers from the request
    const authorization = req.headers[Headers.Authorization];
    const xAmzDate = req.headers[Headers.XAmzDate] as string;
    const xAmzExpires = Number(req.headers[Headers.XAmzExpires]);
    const contentSha256 = req.headers[Headers.XAmzContentSha256];
    const bodyHash = contentSha256 || hash((req as any).rawBody ?? '');
    const { path, query } = parsePath(req.originalUrl!);
    const method = req.method;

    // Check if the required headers are present
    if (!authorization || !xAmzDate) {
        return {
            success: false,
            error: "MISSING_HEADERS"
        };
    }

    // Expires? use xAmzExpires [seconds] to calculate
    // if xAmzExpires not set will be ignored.
    const expired = expires(xAmzDate, xAmzExpires);
    if (expired) {
        return {
            success: false,
            error: "EXPIRED"
        };
    }

    // Extract the necessary information from the authorization header
    const [, credentialRaw, signedHeadersRaw, _signatureRaw] = authorization.split(/\s+/);
    const credential = /=([^,]*)/.exec(credentialRaw)?.[1] ?? ''; // credential.split('=');
    const signedHeaders = /=([^,]*)/.exec(signedHeadersRaw)?.[1] ?? '';
    const [accessKey, date, region, service, requestType] = credential.split('/');
    const incommingHeaders = req.headers;
    const canonicalHeaders = signedHeaders
      .split(';')
      .map((key) => key.toLowerCase() + ':' + trimAll(incommingHeaders[key]))
      .join('\n');

    if (
        !accessKey ||
        !bodyHash ||
        !canonicalHeaders ||
        !date ||
        !method ||
        !path ||
        !region ||
        !requestType ||
        !service ||
        !signedHeaders ||
        !xAmzDate
    ) {
        return {
            success: false,
            error: "SIGNATURE_MISMATCH_1"
        };
    }

    const message = {
        accessKey,
        authorization,
        bodyHash,
        canonicalHeaders,
        date,
        method,
        path,
        region,
        requestType,
        query,
        service,
        signedHeaders,
        xAmzDate,
        xAmzExpires,
    };

    const secretKey = "ursMWwBjQOZeVWFsOsctruPP6EL4WtXrNlykk1gG";
    const calculatedAuthorization = createAuthHeader(message, secretKey);

    if (calculatedAuthorization !== message.authorization) {
        return {
            success: false,
            error: "SIGNATURE_MISMATCH_2"
        };
    }

    return {
        success: true,
        error: null
    };

}

function createAuthHeader(message: any, secretKey: string) {
    return [
        'AWS4-HMAC-SHA256 Credential=' + message.accessKey + '/' + credentialString(message),
        'SignedHeaders=' + message.signedHeaders,
        'Signature=' + signature(message, secretKey),
    ].join(', ');
}

function credentialString(message: any) {
    return [message?.date, message?.region, message?.service, message?.requestType].join('/');
};

function signature(message: any, secretKey: string) {
    const hmacDate = hmac('AWS4' + secretKey, message.date);
    const hmacRegion = hmac(hmacDate, message.region);
    const hmacService = hmac(hmacRegion, message.service);
    const hmacCredentials = hmac(hmacService, 'aws4_request');
    return hmacHex(hmacCredentials, stringToSign(message));
};

function stringToSign(message: any) {
    return ['AWS4-HMAC-SHA256', message.xAmzDate, credentialString(message), hash(canonicalString(message))].join(
      '\n',
    );
};

function canonicalString(message: any) {
    return [
        message.method,
        canonicalURI(message),
        canonicalQueryString(message),
        message.canonicalHeaders + '\n',
        message.signedHeaders,
        message.bodyHash,
    ].join('\n');
};

function canonicalQueryString(message: any) {

    if (!message.query) {
        return '';
    }

    const reducedQuery = Object.keys(message.query).reduce<any>((obj, key) => {
        if (!key) {
            return obj;
        }
        obj[encodeRfc3986Full(key)] = message?.query?.[key];
        return obj;
    }, {});

    const encodedQueryPieces: string[] = [];
    Object.keys(reducedQuery)
        .sort()
        .forEach((key) => {
            if (!Array.isArray(reducedQuery[key])) {
                encodedQueryPieces.push(key + '=' + encodeRfc3986Full((reducedQuery[key] as string) ?? ''));
            } else {
                (reducedQuery[key] as string[])
                ?.map(encodeRfc3986Full)
                ?.sort()
                ?.forEach((val: string) => {
                    encodedQueryPieces.push(key + '=' + val);
                });
            }
        });
    return encodedQueryPieces.join('&');
  };

function canonicalURI(message: any) {

    let pathStr = decodeURIComponent(message.path);
    if (pathStr !== '/') {
        pathStr = pathStr.replace(/\/{2,}/g, '/');
        pathStr = pathStr
            .split('/')
            .reduce((_path: string[], piece: any) => {
            if (piece === '..') {
                _path.pop();
            } else if (piece !== '.') {
                _path.push(encodeRfc3986Full(piece));
            }
            return _path;
            }, [])
            .join('/');
        if (pathStr[0] !== '/') {
            pathStr = '/' + pathStr;
        }
    }
    return pathStr;
};

const hash = (data: string) => crypto.createHash('sha256').update(data, 'utf8').digest('hex');
const trimAll = (header: string | string[] | undefined) => header?.toString().trim().replace(/\s+/g, ' ');
const encodeRfc3986 = (urlEncodedString: string) => urlEncodedString.replace(/[!'()*]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase());
const encodeRfc3986Full = (str: string) => encodeRfc3986(encodeURIComponent(str));
const hmacHex = (secretKey: BinaryLike | KeyObject, data: string) => crypto.createHmac('sha256', secretKey).update(data, 'utf8').digest('hex');
const hmac = (secretKey: BinaryLike | KeyObject, data: string) => crypto.createHmac('sha256', secretKey).update(data, 'utf8').digest();
const expires = (dateTime: string, expires: number | undefined): boolean => {

    if (!expires) {
        return false;
    }
  
    const stringISO8601 = dateTime.replace(/^(.{4})(.{2})(.{2})T(.{2})(.{2})(.{2})Z$/, '$1-$2-$3T$4:$5:$6Z');
    const localDateTime = new Date(stringISO8601);
    localDateTime.setSeconds(localDateTime.getSeconds(), expires);
  
    return localDateTime < new Date();
};
const parsePath = (url: string) => {
    let path = url || '/';
    if (/[^0-9A-Za-z;,/?:@&=+$\-_.!~*'()#%]/.test(path)) {
      path = encodeURI(decodeURI(path));
    }

    const queryIx = path.indexOf('?');
    let query;

    if (queryIx >= 0) {
      query = querystring.parse(path.slice(queryIx + 1));
      path = path.slice(0, queryIx);
    }

    return {
      path,
      query,
    };
};
export default verifySigV4;
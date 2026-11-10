// src/core/validation.js
// Input validation for /api/add-event (manual event submissions).
//
// Mirrors the caps the scrapers already enforce so a manually-added event
// can't slip past validation a scraped one is subject to. Reuses the
// same URL validity checks (isValidImageUrl / isValidRegistrationUrl)
// that sanitizeEventFields applies to scraped fields.

const { isValidImageUrl, isValidRegistrationUrl } = require('./normalize');
const { MAX_TAGS_RENDERED, MAX_TAG_LENGTH } = require('../config/constants');

const MAX_LENGTHS = {
    title: 300,
    description: 1500,
    category: 100,
    date: 200,
    time: 100,
    location: 300,
    organizer: 200,
    price: 100,
    attendanceMode: 100
};

function validateAddEventPayload(eventData) {
    if (!eventData || typeof eventData !== 'object') return 'Payload must be a JSON object.';

    for (const [field, maxLen] of Object.entries(MAX_LENGTHS)) {
        const value = eventData[field];
        if (value === undefined || value === null || value === '') continue;
        if (typeof value !== 'string') return `Field "${field}" must be a string.`;
        if (value.length > maxLen) return `Field "${field}" exceeds the maximum length of ${maxLen} characters.`;
    }

    if (eventData.tags !== undefined && eventData.tags !== null) {
        if (!Array.isArray(eventData.tags)) return 'Field "tags" must be an array of strings.';
        if (eventData.tags.length > MAX_TAGS_RENDERED * 3) return `Field "tags" cannot contain more than ${MAX_TAGS_RENDERED * 3} entries.`;
        for (const tag of eventData.tags) {
            if (typeof tag !== 'string') return 'Field "tags" must contain only strings.';
            if (tag.length > MAX_TAG_LENGTH) return `Each tag must be ${MAX_TAG_LENGTH} characters or fewer.`;
        }
    }

    if (eventData.image !== undefined && eventData.image !== null && eventData.image !== '') {
        if (typeof eventData.image !== 'string' || !isValidImageUrl(eventData.image)) {
            return 'Field "image" must be a valid http(s) image URL (not a data URI or known placeholder).';
        }
    }

    if (eventData.registrationUrl !== undefined && eventData.registrationUrl !== null && eventData.registrationUrl !== '') {
        if (typeof eventData.registrationUrl !== 'string' || !isValidRegistrationUrl(eventData.registrationUrl)) {
            return 'Field "registrationUrl" must be a valid http(s) URL.';
        }
    }

    return null;
}

module.exports = { validateAddEventPayload, MAX_LENGTHS };

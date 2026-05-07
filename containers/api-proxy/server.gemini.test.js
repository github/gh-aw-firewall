/**
 * Tests for Gemini-specific functionality: stripGeminiKeyParam.
 *
 * Extracted from server.test.js lines 525–585.
 */

const { stripGeminiKeyParam } = require('./proxy-utils');

describe('stripGeminiKeyParam', () => {
  it('should remove the key= query parameter', () => {
    expect(stripGeminiKeyParam('/v1/models/gemini-pro:generateContent?key=placeholder'))
      .toBe('/v1/models/gemini-pro:generateContent');
  });

  it('should remove key= while preserving other query parameters', () => {
    expect(stripGeminiKeyParam('/v1/models/gemini-pro:generateContent?key=placeholder&alt=json'))
      .toBe('/v1/models/gemini-pro:generateContent?alt=json');
  });

  it('should return path unchanged when no key= parameter is present', () => {
    expect(stripGeminiKeyParam('/v1/models/gemini-pro:generateContent'))
      .toBe('/v1/models/gemini-pro:generateContent');
  });

  it('should return path unchanged when only unrelated query parameters exist', () => {
    expect(stripGeminiKeyParam('/v1/models/gemini-pro:generateContent?alt=json&stream=true'))
      .toBe('/v1/models/gemini-pro:generateContent?alt=json&stream=true');
  });

  it('should handle root path without key param', () => {
    expect(stripGeminiKeyParam('/')).toBe('/');
  });

  it('should handle path with only key= param, leaving no trailing ?', () => {
    const result = stripGeminiKeyParam('/v1/generateContent?key=abc');
    expect(result).toBe('/v1/generateContent');
  });

  it('should remove the apiKey= query parameter', () => {
    expect(stripGeminiKeyParam('/v1/models/gemini-pro:generateContent?apiKey=placeholder'))
      .toBe('/v1/models/gemini-pro:generateContent');
  });

  it('should remove the api_key= query parameter', () => {
    expect(stripGeminiKeyParam('/v1/models/gemini-pro:generateContent?api_key=placeholder'))
      .toBe('/v1/models/gemini-pro:generateContent');
  });

  it('should remove apiKey= while preserving other query parameters', () => {
    expect(stripGeminiKeyParam('/v1/models/gemini-pro:generateContent?apiKey=placeholder&alt=json'))
      .toBe('/v1/models/gemini-pro:generateContent?alt=json');
  });

  it('should remove api_key= while preserving other query parameters', () => {
    expect(stripGeminiKeyParam('/v1/models/gemini-pro:generateContent?api_key=placeholder&alt=json'))
      .toBe('/v1/models/gemini-pro:generateContent?alt=json');
  });

  it('should remove all auth params when multiple variants are present', () => {
    expect(stripGeminiKeyParam('/v1/models/gemini-pro:generateContent?key=foo&apiKey=bar&api_key=baz&alt=json'))
      .toBe('/v1/models/gemini-pro:generateContent?alt=json');
  });

  it('should handle path with only api_key= param, leaving no trailing ?', () => {
    const result = stripGeminiKeyParam('/v1/generateContent?api_key=abc');
    expect(result).toBe('/v1/generateContent');
  });
});

'use strict';

const transformGitterTextIntoMatrixMessage = require('./transform-gitter-text-into-matrix-message');

function generateMatrixContentFromGitterMessage(model) {
  const matrixCompatibleText = transformGitterTextIntoMatrixMessage(model.text, model);
  const matrixCompatibleHtml = transformGitterTextIntoMatrixMessage(model.html, model);

  let msgtype = 'm.text';
  // Check whether it's a `/me` status message
  if (model.status) {
    msgtype = 'm.emote';
  }

  const matrixContent = {
    body: matrixCompatibleText,
    format: 'org.matrix.custom.html',
    formatted_body: matrixCompatibleHtml,
    msgtype
  };

  return matrixContent;
}

module.exports = generateMatrixContentFromGitterMessage;

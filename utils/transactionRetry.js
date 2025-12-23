// utils/transactionRetry.js
async function withTransactionRetry(session, operation, maxRetries = 3, baseDelay = 100) {
  let lastError;
  
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      await session.startTransaction();
      const result = await operation(session);
      await session.commitTransaction();
      return result;
    } catch (error) {
      await session.abortTransaction();
      
      // Check if this is a retryable error
      if (isRetryableError(error) && attempt < maxRetries) {
        const delay = baseDelay * Math.pow(2, attempt - 1);
        console.warn(`Transaction attempt ${attempt} failed, retrying in ${delay}ms:`, error.message);
        await new Promise(resolve => setTimeout(resolve, delay));
        lastError = error;
        continue;
      }
      
      throw error;
    }
  }
  
  throw lastError;
}

function isRetryableError(error) {
  // Transaction aborted errors
  if (error.message?.includes('has been aborted')) return true;
  
  // Write conflicts
  if (error.code === 112) return true;
  
  // Primary stepped down
  if (error.code === 189) return true;
  
  // Network errors
  if (error.code === 6 || error.code === 7) return true;
  
  return false;
}

module.exports = { withTransactionRetry, isRetryableError };
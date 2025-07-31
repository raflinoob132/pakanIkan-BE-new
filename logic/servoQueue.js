// ini adalah fungsi untuk mengelola antrian tugas servo agar tidak saling tumpang tindih
const queue = [];
let isProcessing = false;

function enqueue(task) {
  queue.push(task);
  processQueue();
}

async function processQueue() {
  if (isProcessing) return;

  isProcessing = true;

  while (queue.length > 0) {
    const task = queue.shift();
    try {
      await task();
    } catch (err) {
      console.error("Error saat menjalankan task di queue:", err);
    }
  }

  isProcessing = false;
}

module.exports = { enqueue };

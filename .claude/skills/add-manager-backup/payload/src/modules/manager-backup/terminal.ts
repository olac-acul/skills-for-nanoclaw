/** Hidden input at the terminal, for the command-line tools of the backup and the panel. */
import readline from 'node:readline';

/** Ask a question and read the answer without echoing it; null when stdin is not an interactive terminal. */
export async function readHidden(question: string): Promise<string | null> {
  if (!process.stdin.isTTY) return null;
  const rl = readline.createInterface({ input: process.stdin, output: process.stderr, terminal: true });
  const hidden = rl as unknown as { _writeToOutput: (text: string) => void };
  const write = hidden._writeToOutput.bind(rl);
  process.stderr.write(question);
  hidden._writeToOutput = () => undefined;
  return new Promise((resolve) => {
    rl.question('', (answer) => {
      hidden._writeToOutput = write;
      rl.close();
      process.stderr.write('\n');
      resolve(answer);
    });
  });
}

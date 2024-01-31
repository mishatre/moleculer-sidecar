
import { Runner } from "moleculer";
import path from "path";

const runner = new Runner();
export default runner.start(process.argv)
    .then(async () => {
        await runner.broker!.loadService(path.join(__dirname, "src", "index.js"))
    })
    .catch(err => {
		// eslint-disable-next-line no-console
		console.error(err);
		process.exit(1);
	});
async function collection(source, target, {config, utils}) { return utils.run('bin/record', [config.prefix, source, target]); }

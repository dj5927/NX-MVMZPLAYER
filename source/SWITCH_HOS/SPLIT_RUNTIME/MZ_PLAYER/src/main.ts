import { reportFatal, runEngine } from '../../common/engine';

runEngine('MZ', '0.52.0').catch(reportFatal);


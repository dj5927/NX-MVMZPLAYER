import { reportFatal, runEngine } from '../../common/engine';

runEngine('MV', '0.52.0').catch(reportFatal);

